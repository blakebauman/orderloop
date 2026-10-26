import {
  type CartGuest,
  type Principal,
  signCartGuestSession,
  verifyRpcActor,
} from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
const env = { PRINCIPAL_KEY: 'web-test-key', API_LIMIT: { limit } };
const searchCartProducts = vi.fn();
const principal = vi.fn(async (_r: Request): Promise<Principal | null> => null);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ searchCartProducts }) }));
vi.mock('~/lib/auth.server', () => ({
  principal,
  setupDue: () => null,
  cookie: (request: Request, name: string) =>
    (request.headers.get('cookie') ?? '')
      .split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1),
}));

const route = await import('../app/routes/cart-products');

const guest: CartGuest = { cartId: 'cart_1', id: 'guest:b1', name: 'Pat Buyer' };
const guestCookie = async (g = guest) =>
  `ol_${g.cartId}=${await signCartGuestSession(env.PRINCIPAL_KEY, g, Date.now() + 60_000)}`;
const staff: Principal = { kind: 'user', id: 'usr_1', name: 'Ada', role: 'operator' };
const found = {
  ok: true,
  currency: 'USD',
  more: false,
  products: [{ sku: 'WID-100', name: 'Industrial widget', unitPrice: 21.5 }],
};

/** The loader's answer: its data, or the status and body of what it threw. */
const get = (q: string | null, headers: Record<string, string> = {}, cartId = 'cart_1') =>
  route
    .loader({
      request: new Request(
        `https://app.test/carts/${cartId}/products${q === null ? '' : `?q=${encodeURIComponent(q)}`}`,
        { headers },
      ),
      params: { cartId },
    } as never)
    .then(
      (r) => ({ status: r.init?.status ?? 200, data: r.data, headers: r.init?.headers }),
      async (e: { init?: { status: number }; data?: unknown } | Response) =>
        e instanceof Response
          ? { status: e.status, data: await e.json(), headers: Object.fromEntries(e.headers) }
          : { status: e.init?.status, data: e.data, headers: undefined },
    );

beforeEach(() => {
  searchCartProducts.mockReset();
  limit.mockReset();
  limit.mockResolvedValue({ success: true });
  principal.mockResolvedValue(null);
});

describe('searching products from a cart', () => {
  it('asks the engine as the signed-in person, signed for this cart, and answers the page', async () => {
    principal.mockResolvedValue(staff);
    searchCartProducts.mockResolvedValue(found);
    const r = await get('widget');
    expect(r).toMatchObject({
      status: 200,
      data: { currency: 'USD', more: false, products: found.products },
    });
    expect(r.data).not.toHaveProperty('ok');
    expect(r.headers).toMatchObject({ 'cache-control': 'private, no-store' });
    const [cartId, q, actor] = searchCartProducts.mock.calls[0]!;
    expect([cartId, q]).toEqual(['cart_1', 'widget']);
    // The engine believes only this: who, signed for this cart's calls.
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], actor, 'cart:cart_1')).toEqual({
      kind: 'staff',
      id: 'usr_1',
      name: 'Ada',
      role: 'operator',
    });
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], actor, 'cart:cart_2')).toBeNull();
  });

  it('asks as the buyer a cart admitted, for that cart only', async () => {
    searchCartProducts.mockResolvedValue(found);
    expect(await get('widget', { cookie: await guestCookie() })).toMatchObject({ status: 200 });
    const actor = searchCartProducts.mock.calls[0]![2];
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], actor, 'cart:cart_1')).toEqual({
      kind: 'guest',
      id: 'guest:b1',
      name: 'Pat Buyer',
    });
    // Their cookie for cart_1 opens no other cart's search.
    expect(await get('widget', { cookie: await guestCookie() }, 'cart_2')).toMatchObject({
      status: 401,
    });
    // Nor does a cookie named for cart_2 that was signed for cart_1.
    const moved = (await guestCookie()).replace('ol_cart_1=', 'ol_cart_2=');
    expect(await get('widget', { cookie: moved }, 'cart_2')).toMatchObject({ status: 401 });
    expect(searchCartProducts).toHaveBeenCalledTimes(1);
  });

  it('refuses a stranger, a forged cookie and an expired one without asking the engine', async () => {
    expect(await get('widget')).toMatchObject({ status: 401 });
    expect(await get('widget', { cookie: 'ol_cart_1=forged.value' })).toMatchObject({
      status: 401,
    });
    const lapsed = `ol_cart_1=${await signCartGuestSession(env.PRINCIPAL_KEY, guest, Date.now() - 1)}`;
    expect(await get('widget', { cookie: lapsed })).toMatchObject({ status: 401 });
    const otherKey = `ol_cart_1=${await signCartGuestSession('another-key', guest, Date.now() + 60_000)}`;
    expect(await get('widget', { cookie: otherKey })).toMatchObject({ status: 401 });
    expect(searchCartProducts).not.toHaveBeenCalled();
  });

  it('passes on what the engine refuses: an unknown cart, a viewer, a closed cart', async () => {
    principal.mockResolvedValue(staff);
    searchCartProducts.mockResolvedValueOnce({ ok: false, error: 'No such cart.', notFound: true });
    expect(await get('widget')).toMatchObject({ status: 404, data: { error: 'No such cart.' } });
    searchCartProducts.mockResolvedValueOnce({ ok: false, error: "You can't change this cart." });
    expect(await get('widget')).toMatchObject({
      status: 403,
      data: { error: "You can't change this cart." },
    });
    searchCartProducts.mockResolvedValueOnce({ ok: false, error: 'The cart has closed.' });
    expect(await get('widget', { cookie: await guestCookie() })).toMatchObject({ status: 403 });
  });

  it('passes an empty search on as one, and only so much of a long one', async () => {
    principal.mockResolvedValue(staff);
    searchCartProducts.mockResolvedValue(found);
    await get(null);
    await get('x'.repeat(5_000));
    expect(searchCartProducts.mock.calls.map((c) => (c[1] as string).length)).toEqual([0, 200]);
  });

  it('has no page size to ask for: the engine answers CART_SEARCH_LIMIT at most', async () => {
    principal.mockResolvedValue(staff);
    searchCartProducts.mockResolvedValue(found);
    await route.loader({
      request: new Request('https://app.test/carts/cart_1/products?q=w&limit=100000&offset=5'),
      params: { cartId: 'cart_1' },
    } as never);
    const call = searchCartProducts.mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call.slice(0, 2)).toEqual(['cart_1', 'w']);
  });

  it('spends a budget of its own per person, and a buyer’s per cart, refusing past it', async () => {
    principal.mockResolvedValue(staff);
    searchCartProducts.mockResolvedValue(found);
    await get('widget');
    principal.mockResolvedValue(null);
    await get('widget', { cookie: await guestCookie() });
    // Not the /api/v1 key (the person's id alone), so searching never spends the API's budget.
    expect(limit.mock.calls.map((c) => c[0].key)).toEqual([
      'cart-search:usr_1',
      'cart-search:cart_1:guest:b1',
    ]);
    searchCartProducts.mockClear();
    limit.mockResolvedValue({ success: false });
    const r = await get('widget', { cookie: await guestCookie() });
    expect(r).toMatchObject({ status: 429, headers: { 'retry-after': '60' } });
    expect(r.data).toMatchObject({ error: expect.stringMatching(/Too many requests/) });
    expect(searchCartProducts).not.toHaveBeenCalled();
    // A stranger is refused before spending anyone's budget.
    limit.mockClear();
    expect(await get('widget')).toMatchObject({ status: 401 });
    expect(limit).not.toHaveBeenCalled();
  });
});
