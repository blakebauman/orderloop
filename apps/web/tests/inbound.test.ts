import { signWebhook } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = {
  ORDER_ROUTES: JSON.stringify({ 'b2c:pos': 'pos-flow' }),
};
const startOrderOnce = vi.fn();

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ startOrderOnce }) }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({
  currencies: async () => [{ currency: 'USD' }, { currency: 'EUR' }],
  listOrders: async () => [],
}));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({ actor: () => 'api', forbidden: () => 'Forbidden' }));
vi.mock('~/lib/webhooks.server', () => ({}));

const key = (id: string, scope: Record<string, unknown>) => ({
  id,
  name: id,
  secret: 'whsec_test',
  previousSecret: null,
  previousExpiresAt: null,
  events: [],
  startOrders: true,
  flows: ['*'],
  channel: null,
  ...scope,
});
const keys: Record<string, ReturnType<typeof key>> = {
  int_shop: key('int_shop', {}),
  int_pos: key('int_pos', { channel: 'pos', flows: [] }),
  int_payments: key('int_payments', { events: ['payment.received'], startOrders: false }),
};
vi.mock('~/lib/integrations.server', () => ({
  findIntegration: async (id: string) => keys[id] ?? null,
  touchIntegration: async () => {},
}));

const { handleSignedOrder } = await import('~/lib/api.server');

const order = {
  model: 'b2c',
  channel: 'web',
  externalId: 'shop-1001',
  contact: { email: 'sam@example.com' },
  lines: [{ sku: 'MON-27', qty: 1 }],
};

async function post(body: unknown, secret = 'whsec_test', keyId = 'int_shop') {
  const raw = JSON.stringify(body);
  const signature = await signWebhook(secret, raw, undefined, keyId);
  return handleSignedOrder(
    new Request('https://app.test/api/v1/webhooks/orders', {
      method: 'POST',
      headers: { 'x-orderloop-signature': signature },
      body: raw,
    }),
  );
}

describe('POST /api/v1/webhooks/orders', () => {
  beforeEach(() => {
    startOrderOnce.mockReset();
  });

  it('starts the routed flow once per channel and external id', async () => {
    startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1' });
    const res = await post(order);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orderId: 'ord_1', flowId: 'tpl-storefront-order' });
    expect(startOrderOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'tpl-storefront-order',
        idempotencyKey: 'order:web:shop-1001',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        input: expect.objectContaining({ channel: 'web', meta: { via: 'webhook' } }),
      }),
    );

    startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1', replayed: true });
    const replay = await post(order);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ orderId: 'ord_1', replayed: true });
    // The new order is recorded against the integration that signed it; the replay is not.
    expect(audit.mock.calls.filter((c) => c[1] === 'order.started')).toEqual([
      [
        expect.any(Request),
        'order.started',
        {
          actor: expect.objectContaining({ kind: 'integration' }),
          target: 'ord_1',
          detail: expect.objectContaining({ flowId: 'tpl-storefront-order', via: 'webhook' }),
        },
      ],
    ]);
    startOrderOnce.mockResolvedValueOnce({ mismatch: true });
    expect((await post({ ...order, lines: [{ sku: 'MON-27', qty: 2 }] })).status).toBe(422);
  });

  it('uses ORDER_ROUTES and refuses a flow that is not published', async () => {
    startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_2' });
    const res = await post({ ...order, channel: 'pos', externalId: 'till-7' });
    expect(await res.json()).toMatchObject({ flowId: 'pos-flow' });
    startOrderOnce.mockRejectedValueOnce(new Error('Flow pos-flow has no published version'));
    const unpublished = await post({ ...order, channel: 'pos', externalId: 'till-8' });
    expect(unpublished.status).toBe(409);
    expect(await unpublished.json()).toEqual({ error: 'Flow pos-flow is not published' });
  });

  it('holds each integration to its scope', async () => {
    const payments = await post(order, 'whsec_test', 'int_payments');
    expect(payments.status).toBe(403);
    expect(await payments.json()).toEqual({ error: 'This integration may not start orders' });
    expect((await post(order, 'whsec_test', 'int_pos')).status).toBe(403);
    const named = await post(
      { ...order, channel: 'pos', flowId: 'tpl-b2b-order' },
      'whsec_test',
      'int_pos',
    );
    expect(await named.json()).toEqual({
      error: 'This integration may not choose flow tpl-b2b-order',
    });
    expect((await post(order, 'whsec_test', 'int_gone')).status).toBe(401);
    expect(startOrderOnce).not.toHaveBeenCalled();
  });

  it('refuses a bad signature, a bad body and an unknown currency', async () => {
    expect((await post(order, 'whsec_wrong')).status).toBe(401);
    expect((await post({ ...order, externalId: undefined })).status).toBe(400);
    expect((await post({ ...order, currency: 'JPY' })).status).toBe(400);
    expect(startOrderOnce).not.toHaveBeenCalled();
  });
});
