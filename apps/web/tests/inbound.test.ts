import { signWebhook } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = {
  WEBHOOK_SECRET: 'whsec_test',
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
vi.mock('~/lib/audit.server', () => ({ listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({ actor: () => 'api', forbidden: () => 'Forbidden' }));
vi.mock('~/lib/webhooks.server', () => ({}));

const { handleSignedOrder } = await import('~/lib/api.server');

const order = {
  model: 'b2c',
  channel: 'web',
  externalId: 'shop-1001',
  contact: { email: 'sam@example.com' },
  lines: [{ sku: 'MON-27', qty: 1 }],
};

async function post(body: unknown, secret = env.WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const signature = await signWebhook(secret, raw);
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

  it('refuses a bad signature, a bad body and an unknown currency', async () => {
    expect((await post(order, 'whsec_wrong')).status).toBe(401);
    expect((await post({ ...order, externalId: undefined })).status).toBe(400);
    expect((await post({ ...order, currency: 'JPY' })).status).toBe(400);
    expect(startOrderOnce).not.toHaveBeenCalled();
  });
});
