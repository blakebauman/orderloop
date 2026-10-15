import type { Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = { decide: vi.fn(), cancel: vi.fn(), sendEvent: vi.fn() };

const receipts = new Set<string>();
/** Just enough of drizzle for the webhook receipts: claim with insert, release with delete. */
const fakeDb = {
  insert: () => ({
    values: (v: { id: string }) => ({
      onConflictDoNothing: () => ({
        returning: async () => (receipts.has(v.id) ? [] : (receipts.add(v.id), [v])),
      }),
    }),
  }),
  delete: () => ({
    where: async (cond: { eq?: string }) => {
      if (cond.eq) receipts.delete(cond.eq);
    },
  }),
};
// The release deletes by id (`eq`); the prune by age (`lt`) leaves fresh receipts alone.
vi.mock('drizzle-orm', async (actual) => ({
  ...(await actual<typeof import('drizzle-orm')>()),
  eq: (_col: unknown, value: string) => ({ eq: value }),
  lt: () => ({}),
}));
const env: Record<string, unknown> = {};

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => engine, db: () => fakeDb }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({ currencies: async () => [], listOrders: async () => [] }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({
  actor: () => 'ops@example.com',
  forbidden: () => 'Forbidden',
}));
vi.mock('~/lib/webhooks.server', () => ({}));

const scope = { events: ['payment.received'], startOrders: false, flows: [], channel: null };
const keys: Record<string, Record<string, unknown>> = {
  int_pay: {
    id: 'int_pay',
    name: 'Payments',
    secret: 'whsec_test',
    previousSecret: null,
    previousExpiresAt: null,
    ...scope,
  },
  int_web: {
    id: 'int_web',
    name: 'Storefront',
    secret: 'whsec_web',
    previousSecret: null,
    previousExpiresAt: null,
    ...scope,
    events: ['*'],
    channel: 'web',
  },
};
const channels: Record<string, string> = { ord_x: 'web', ord_pos: 'pos' };
const integrations = {
  findIntegration: async (id: string) => keys[id] ?? null,
  touchIntegration: async () => {},
  orderChannel: async (id: string) => channels[id] ?? null,
  createIntegration: vi.fn(),
  rotateIntegration: vi.fn(),
  revokeIntegration: vi.fn(),
  listIntegrations: vi.fn(),
};
vi.mock('~/lib/integrations.server', () => integrations);

const { handleApi, handleSignedEvent } = await import('~/lib/api.server');
const { signWebhook } = await import('@orderloop/core');

const operator: Principal = { kind: 'token', id: 'tok_1', name: 'ci', role: 'operator' };
const admin: Principal = { ...operator, id: 'tok_2', role: 'admin' };
const post = (path: string, body: unknown, as = operator) =>
  handleApi(
    new Request(`https://app.test/api/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    as,
  );

describe('order actions over REST', () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
  });

  it('answers 404 for an unknown order and 409 for a step that is not waiting', async () => {
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'approved' })).status).toBe(404);
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_waiting' });
    const busy = await post('orders/ord_x/approvals/mgr', { decision: 'approved' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'mgr is not waiting for an approval' });
    engine.decide.mockResolvedValueOnce({ ok: true });
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'approved' })).status).toBe(200);
  });

  it('answers 409 when cancelling an order that already finished', async () => {
    engine.cancel.mockResolvedValueOnce({ ok: false, reason: 'finished' });
    const res = await post('orders/ord_x/cancel', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The order has already finished' });
    engine.cancel.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await post('orders/ord_x/cancel', {})).status).toBe(404);
    engine.cancel.mockResolvedValueOnce({ ok: true });
    expect((await post('orders/ord_x/cancel', {})).status).toBe(200);
  });

  it('answers 404 for an event to an unknown order', async () => {
    engine.sendEvent.mockResolvedValueOnce({ delivered: false, notFound: true });
    expect((await post('orders/ord_x/events', { event: 'payment.received' })).status).toBe(404);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    const early = await post('orders/ord_x/events', { event: 'payment.received' });
    expect(early.status).toBe(200);
    expect(await early.json()).toEqual({ delivered: false });
  });
});

describe('request validation', () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
  });

  it('refuses malformed and oversized bodies before reaching the engine', async () => {
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'maybe' })).status).toBe(400);
    expect((await post('orders/ord_x/events', { event: 42 })).status).toBe(400);
    expect(
      (await post('orders/ord_x/events', { event: 'x', payload: { blob: 'a'.repeat(40_000) } }))
        .status,
    ).toBe(400);
    expect((await post('orders/ord_x/cancel', { reason: 'r'.repeat(501) })).status).toBe(400);
    const huge = await post('orders/ord_x/cancel', { reason: 'r'.repeat(2 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(engine.decide).not.toHaveBeenCalled();
    expect(engine.sendEvent).not.toHaveBeenCalled();
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it('answers an engine failure without its internals', async () => {
    engine.cancel.mockRejectedValueOnce(new Error('D1_ERROR: no such table: orders'));
    const res = await post('orders/ord_x/cancel', {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
  });
});

describe('signed events', () => {
  const send = async (raw: string, signature: string) =>
    handleSignedEvent(
      new Request('https://app.test/api/v1/webhooks/events', {
        method: 'POST',
        headers: { 'x-orderloop-signature': signature },
        body: raw,
      }),
    );

  beforeEach(() => {
    receipts.clear();
    engine.sendEvent.mockReset();
  });

  const sign = (raw: string, keyId = 'int_pay', secret = 'whsec_test') =>
    signWebhook(secret, raw, undefined, keyId);

  it('delivers a signed event once, and lets a sender retry one nothing was waiting for', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    const signature = await sign(raw);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    expect((await send(raw, signature)).status).toBe(409);
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    expect((await send(raw, signature)).status).toBe(200);
    const replay = await send(raw, signature);
    expect(await replay.json()).toEqual({ delivered: true, duplicate: true });
    expect(engine.sendEvent).toHaveBeenCalledTimes(2);
  });

  it('refuses a key that names no integration, an unknown one, or the wrong secret', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    expect((await send(raw, await signWebhook('whsec_test', raw))).status).toBe(401);
    expect((await send(raw, await sign(raw, 'int_nope'))).status).toBe(401);
    expect((await send(raw, await sign(raw, 'int_pay', 'whsec_other'))).status).toBe(401);
    expect(engine.sendEvent).not.toHaveBeenCalled();
  });

  it("keeps an integration to its events and its channel's orders", async () => {
    const ship = JSON.stringify({ orderId: 'ord_x', event: 'shipment.delivered' });
    const refused = await send(ship, await sign(ship));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'This integration may not deliver shipment.delivered',
    });

    const pos = JSON.stringify({ orderId: 'ord_pos', event: 'payment.received' });
    expect((await send(pos, await sign(pos, 'int_web', 'whsec_web'))).status).toBe(403);
    const missing = JSON.stringify({ orderId: 'ord_missing', event: 'payment.received' });
    expect((await send(missing, await sign(missing, 'int_web', 'whsec_web'))).status).toBe(404);

    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    const web = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    expect((await send(web, await sign(web, 'int_web', 'whsec_web'))).status).toBe(200);
    expect(engine.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("spends only a verified integration's budget, and answers 429 once it runs out", async () => {
    const spent: string[] = [];
    env.WEBHOOK_LIMIT = {
      limit: async ({ key }: { key: string }) => {
        spent.push(key);
        return { success: spent.length < 2 };
      },
    };
    try {
      const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
      // A forged signature is refused before it can use up the real sender's budget.
      expect((await send(raw, await sign(raw, 'int_pay', 'whsec_other'))).status).toBe(401);
      expect(spent).toEqual([]);
      engine.sendEvent.mockResolvedValue({ delivered: true, nodeId: 'pay' });
      expect((await send(raw, await sign(raw))).status).toBe(200);
      const limited = await send(raw, await sign(raw));
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(spent).toEqual(['int_pay', 'int_pay']);
      expect(engine.sendEvent).toHaveBeenCalledTimes(1);
    } finally {
      delete env.WEBHOOK_LIMIT;
    }
  });
});

describe('integrations over REST', () => {
  beforeEach(() => audit.mockReset());

  it('creates a key, shows its secret once, and records who did', async () => {
    integrations.createIntegration.mockResolvedValueOnce({
      integration: { id: 'int_new', name: 'Stripe' },
      secret: 'whsec_abc',
    });
    const res = await post('integrations', { name: 'Stripe', events: ['payment.received'] }, admin);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ secret: 'whsec_abc' });
    expect(integrations.createIntegration).toHaveBeenCalledWith(
      { name: 'Stripe', events: ['payment.received'], startOrders: false, flows: [] },
      'ops@example.com',
    );
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'integration.created', {
      actor: admin,
      target: 'Stripe',
      detail: { id: 'int_new' },
    });
  });

  it('rotates and revokes, 404 for an unknown key, and needs an admin', async () => {
    integrations.rotateIntegration.mockResolvedValueOnce({
      integration: { name: 'Stripe' },
      secret: 'whsec_2',
    });
    expect((await post('integrations/int_new/rotate', {}, admin)).status).toBe(200);
    integrations.rotateIntegration.mockResolvedValueOnce(null);
    expect((await post('integrations/int_nope/rotate', {}, admin)).status).toBe(404);
    integrations.revokeIntegration.mockResolvedValueOnce({ name: 'Stripe' });
    const del = await handleApi(
      new Request('https://app.test/api/v1/integrations/int_new', { method: 'DELETE' }),
      admin,
    );
    expect(del.status).toBe(200);
    expect(audit.mock.calls.map((c) => c[1])).toEqual([
      'integration.rotated',
      'integration.revoked',
    ]);
    // Operators run orders and flows; keys, webhooks and the audit log are an admin's.
    for (const path of ['integrations', 'webhook-subscriptions', 'audit-events'])
      expect(
        (await handleApi(new Request(`https://app.test/api/v1/${path}`), operator)).status,
      ).toBe(403);
  });
});

describe('order list paging', () => {
  it('round-trips a cursor and refuses one it did not issue', async () => {
    const { decodeCursor, encodeCursor } = await import('~/lib/cursor');
    const c = { createdAt: 1_790_000_000_000, id: 'ord_abc:1' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-base64!')).toBeNull();
    expect(decodeCursor(btoa('later:ord_1'))).toBeNull();
    const res = await handleApi(
      new Request('https://app.test/api/v1/orders?cursor=bogus'),
      operator,
    );
    expect(res.status).toBe(400);
  });
});
