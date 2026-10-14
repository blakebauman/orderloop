import type { Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = { decide: vi.fn(), cancel: vi.fn(), sendEvent: vi.fn() };

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ engine: () => engine }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({ currencies: async () => [], listOrders: async () => [] }));
vi.mock('~/lib/audit.server', () => ({ listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({
  actor: () => 'ops@example.com',
  forbidden: () => 'Forbidden',
}));
vi.mock('~/lib/webhooks.server', () => ({}));

const { handleApi } = await import('~/lib/api.server');

const operator: Principal = { kind: 'token', id: 'tok_1', name: 'ci', role: 'operator' };
const post = (path: string, body: unknown) =>
  handleApi(
    new Request(`https://app.test/api/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    operator,
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
