import {
  type Cart,
  type CartGuest,
  type CartState,
  PRINCIPAL_HEADER,
  type Principal,
  signCartGuestSession,
  verifyCartGuest,
  verifyPrincipal,
} from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { PRINCIPAL_KEY: 'web-test-key' };
const engineFetch = vi.fn(async (_r: Request) => new Response('ok'));
const redeemCartStart = vi.fn();
const cartSnapshot = vi.fn();
const principal = vi.fn(async (_r: Request): Promise<Principal | null> => null);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: engineFetch, redeemCartStart, cartSnapshot }),
  db: () => ({ select: () => ({ from: () => ({ orderBy: async () => [] }) }) }),
  docs: () => ({}),
}));
vi.mock('~/lib/orders.server', () => ({ customerNames: async () => ({}) }));
vi.mock('~/lib/auth.server', () => ({
  principal,
  apiPrincipal: vi.fn(),
  awaitingSetup: async () => false,
  sessionId: async () => 'ses_1',
  setupDue: () => null,
  Throttled: class extends Error {},
  TokenExpired: class extends Error {},
  cookie: (request: Request, name: string) =>
    (request.headers.get('cookie') ?? '')
      .split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1),
}));

const { default: worker } = await import('../workers/app');
const cartStart = await import('../app/routes/cart-start');
const cartBuy = await import('../app/routes/cart-buy');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const guest: CartGuest = { cartId: 'cart_1', id: 'guest:b1', name: 'Pat Buyer' };
const guestCookie = async (g = guest) =>
  `ol_${g.cartId}=${await signCartGuestSession(env.PRINCIPAL_KEY, g, Date.now() + 60_000)}`;
const socket = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://app.test${path}`, {
      headers: { upgrade: 'websocket', origin: 'https://app.test', ...headers },
    }) as never,
    env as never,
    ctx,
  );

describe('an external cart’s buyer on its socket', () => {
  beforeEach(() => {
    engineFetch.mockClear();
    principal.mockReset();
    principal.mockResolvedValue(null);
  });

  it('forwards the buyer to their own cart with a guest header and no credentials', async () => {
    const res = await socket('/agents/cart-agent/cart_1', {
      cookie: await guestCookie(),
      authorization: 'Basic eDp5',
    });
    expect(res.status).toBe(200);
    const forwarded = engineFetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/agents/cart-agent/cart_1');
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBeNull();
    const header = forwarded.headers.get(PRINCIPAL_HEADER);
    expect(await verifyCartGuest([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_1')).toEqual(
      guest,
    );
    // Signed for this path alone, and never as a principal.
    expect(await verifyCartGuest([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_2')).toBe(
      null,
    );
    expect(await verifyPrincipal([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_1')).toBe(
      null,
    );
  });

  it('refuses a buyer’s cookie on another cart’s socket', async () => {
    const res = await socket('/agents/cart-agent/cart_2', { cookie: await guestCookie() });
    expect(res.status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed cart id instead of failing on it', async () => {
    for (const path of ['/agents/cart-agent/%E0%A4%A', '/agents/cart-agent/cart%5F1']) {
      const res = await socket(path, { cookie: await guestCookie() });
      expect(res.status).toBe(401);
    }
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('forwards a signed-in person as themselves, not as the buyer whose cookie they hold', async () => {
    const staff: Principal = { kind: 'user', id: 'usr_1', name: 'Sam', role: 'operator' };
    principal.mockResolvedValue(staff);
    await socket('/agents/cart-agent/cart_1', { cookie: await guestCookie() });
    const header = engineFetch.mock.calls[0]![0].headers.get(PRINCIPAL_HEADER);
    expect(
      await verifyPrincipal([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_1'),
    ).toMatchObject({ ...staff, session: 'ses_1' });
    expect(await verifyCartGuest([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_1')).toBe(
      null,
    );
  });
});

/** What a loader threw, as React Router sees a `data()` refusal. */
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    const { data, init } = e as { data: string; init: ResponseInit };
    return { message: data, status: init.status, headers: new Headers(init.headers) };
  }
  throw new Error('expected a refusal');
}

const external = {
  pluginId: 'punchout',
  sessionRef: 's1',
  expiresAt: Date.now() + 60_000,
  returnUrl: 'https://buyer.example/punchout;jsessionid=A',
  frameOrigins: ['https://buyer.example'],
  buyer: { id: 'b1', name: 'Pat Buyer' },
};
const snapshot = (cart: Partial<Cart>): CartState => ({
  cart: { id: 'cart_1', status: 'open', customerId: null, external, ...cart } as Cart,
  members: [],
  chat: [],
});

describe('the buyer’s pages refuse in a frame they can show', () => {
  const frameable = (headers: Headers) =>
    expect(JSON.parse(headers.get('x-orderloop-embed') ?? '{}')).toEqual({
      frameAncestors: ['https:'],
    });

  it('a used or expired start link', async () => {
    redeemCartStart.mockResolvedValueOnce(null);
    const r = await refusal(() =>
      cartStart.loader({ params: { cartId: 'cart_1', token: 't' } } as never),
    );
    expect(r.status).toBe(410);
    expect(r.message).toMatch(/used or has expired/);
    frameable(r.headers);
    expect(
      cartStart.headers({ errorHeaders: r.headers, loaderHeaders: new Headers() } as never),
    ).toBe(r.headers);
  });

  it('a cart page without the buyer’s cookie', async () => {
    const r = await refusal(() =>
      cartBuy.loader({
        request: new Request('https://app.test/cart/cart_1'),
        params: { cartId: 'cart_1' },
      } as never),
    );
    expect(r.status).toBe(401);
    frameable(r.headers);
    expect(cartSnapshot).not.toHaveBeenCalled();
  });

  it('a cart that has closed, but not one that went back to the buyer', async () => {
    const request = new Request('https://app.test/cart/cart_1', {
      headers: { cookie: await guestCookie() },
    });
    const load = () => cartBuy.loader({ request, params: { cartId: 'cart_1' } } as never);
    for (const cart of [
      { status: 'canceled' as const },
      { status: 'submitted' as const },
      { external: { ...external, expiresAt: Date.now() - 1 } },
    ]) {
      cartSnapshot.mockResolvedValueOnce(snapshot(cart));
      const r = await refusal(load);
      expect(r.status).toBe(410);
      expect(r.message).toMatch(/has closed/);
      frameable(r.headers);
    }
    cartSnapshot.mockResolvedValueOnce(snapshot({ status: 'returned' }));
    const page = (await load()) as unknown as { init: ResponseInit };
    expect(JSON.parse(new Headers(page.init.headers).get('x-orderloop-embed')!)).toEqual({
      frameAncestors: ['https://buyer.example'],
      formAction: ['https://buyer.example/punchout;jsessionid=A'],
    });
  });
});
