import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = { decide: vi.fn() };
const audit = vi.fn(async () => {});
vi.mock('~/lib/env.server', () => ({ engine: () => engine }));
vi.mock('~/lib/audit.server', () => ({ audit }));
vi.mock('~/lib/auth.server', () => ({
  requireUser: async () => ({ kind: 'user', id: 'usr_a', name: 'Ann', role: 'approver' }),
  actor: () => 'Ann',
}));
vi.mock('~/lib/principal.server', () => ({
  decider: (me: unknown) => me,
  signedActor: async () => 'signed',
}));

const { action } = await import('~/routes/order-action');

const decide = (intent: 'approve' | 'reject') => {
  const body = new FormData();
  body.set('intent', intent);
  body.set('nodeId', 'mgr');
  return action({
    request: new Request('https://app.test/orders/ord_bench/action', { method: 'POST', body }),
    params: { orderId: 'ord_bench' },
    context: {},
  } as never) as Promise<{ data: { ok: boolean; error?: string }; init: { status: number } }>;
};

beforeEach(() => {
  engine.decide.mockReset();
  audit.mockClear();
});

describe('deciding from a form post', () => {
  it('refuses an order with no live run with a 409 that says so, and records nothing', async () => {
    // The page no longer offers it; a post sent anyway still gets a plain answer, not a 500.
    for (const intent of ['approve', 'reject'] as const) {
      engine.decide.mockResolvedValueOnce({ ok: false, reason: 'no_run' });
      const r = await decide(intent);
      expect(r.init.status).toBe(409);
      expect(r.data).toEqual({
        ok: false,
        error: 'No live run for this order, so it can’t be decided.',
      });
    }
    expect(audit).not.toHaveBeenCalled();
  });

  it('keeps "no longer exists" for an order the engine has never heard of', async () => {
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    const r = await decide('approve');
    expect(r.init.status).toBe(404);
    expect(r.data.error).toBe('That order no longer exists');
  });

  it('records a decision the engine took', async () => {
    engine.decide.mockResolvedValueOnce({ ok: true });
    expect(await decide('approve')).toEqual({ ok: true });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'approval.decided', {
      actor: expect.objectContaining({ id: 'usr_a' }),
      target: 'ord_bench',
      detail: { nodeId: 'mgr', decision: 'approved', via: 'app' },
    });
  });
});
