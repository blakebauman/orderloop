import { SESSION_TOUCH_MS } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** Just enough of drizzle for `principal()`: the user count, and the session joined to its user. */
let sessionLookups = 0;
let failNext = false;
let seen = Date.now();
const touches: unknown[] = [];
const select = () => {
  let joined = false;
  const q = {
    from: () => q,
    innerJoin: () => {
      joined = true;
      return q;
    },
    where: () => q,
    get: async () => {
      if (!joined) return { n: 1 };
      sessionLookups++;
      if (failNext) {
        failNext = false;
        throw new Error('D1 unavailable');
      }
      return {
        id: 'usr_ada',
        email: 'ada@example.com',
        name: 'Ada',
        role: 'operator',
        totpEnabledAt: 1,
        passwordChangeDue: false,
        passwordHash: null,
        seen,
      };
    },
  };
  return q;
};
const update = () => ({ set: () => ({ where: () => 'touch' }) });
const afterResponse = vi.fn((work: unknown) => touches.push(work));
vi.mock('~/lib/env.server', () => ({ db: () => ({ select, update }), afterResponse }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/demo.server', () => ({ isDemo: () => false, DEMO_USER: { id: 'usr_demo' } }));
vi.mock('~/lib/settings.server', () => ({
  ssoOnlyInEffect: async () => false,
  twoFactorRequirement: async () => 'none',
}));

const { principal } = await import('~/lib/auth.server');

const page = (path = '/orders/ord_1') =>
  new Request(`https://acme.orderloop.app${path}`, {
    headers: { cookie: '__Host-ol_session=tok_abc' },
  });

describe('principal()', () => {
  beforeEach(() => {
    sessionLookups = 0;
    failNext = false;
    seen = Date.now();
    touches.length = 0;
    afterResponse.mockClear();
  });

  it('looks the session up once per Request, for the shell and the page alike', async () => {
    const request = page();
    const [shell, child] = await Promise.all([principal(request), principal(request)]);
    expect(shell).toMatchObject({ kind: 'user', id: 'usr_ada', role: 'operator' });
    expect(child).toBe(shell);
    expect(await principal(request)).toBe(shell);
    expect(sessionLookups).toBe(1);
  });

  it('looks again for another Request, such as a client navigation’s .data fetch', async () => {
    await principal(page('/orders/ord_1'));
    await principal(page('/orders/ord_1.data'));
    expect(sessionLookups).toBe(2);
  });

  it('does not keep a failed lookup', async () => {
    const request = page();
    failNext = true;
    await expect(principal(request)).rejects.toThrow(/D1 unavailable/);
    expect(await principal(request)).toMatchObject({ id: 'usr_ada' });
    expect(sessionLookups).toBe(2);
  });

  it('records a stale session’s last use after the response, once', async () => {
    seen = Date.now() - SESSION_TOUCH_MS - 1000;
    const request = page();
    await Promise.all([principal(request), principal(request)]);
    expect(afterResponse).toHaveBeenCalledTimes(1);
    expect(touches).toEqual(['touch']);
  });

  it('leaves a recently seen session alone', async () => {
    await principal(page());
    expect(afterResponse).not.toHaveBeenCalled();
  });
});
