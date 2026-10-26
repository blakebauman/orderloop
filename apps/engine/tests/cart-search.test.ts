import { env } from 'cloudflare:workers';
import { CART_SEARCH_LIMIT, type CartActor, type ExternalCart } from '@orderloop/core';
import { createDb, products } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { createCart } from '../src/cart/carts';
import { ensureTemplates } from '../src/flows';
import { signedActor } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
/** As the web app calls it: the actor signed for this cart. */
const search = async (id: string, q: string, a: CartActor, signedFor = id) =>
  api().searchCartProducts(id, q, await signedActor(a, `cart:${signedFor}`));

const ada: CartActor = { kind: 'staff', id: 'usr_ada', name: 'Ada', role: 'operator' };
const vee: CartActor = { kind: 'staff', id: 'usr_vee', name: 'Vee', role: 'viewer' };
const buyer: CartActor = { kind: 'guest', id: 'guest:buyer@example.com', name: 'Buyer' };

const external = (): ExternalCart => ({
  pluginId: 'example',
  sessionRef: `s-${crypto.randomUUID()}`,
  expiresAt: Date.now() + 3_600_000,
  returnUrl: 'https://buyer.example/return',
  frameOrigins: [],
  buyer: { id: 'buyer@example.com', name: 'Buyer' },
});

async function open(
  flowId = 'tpl-b2b-order',
  customerId: string | null = 'cus_northwind',
  ext: ExternalCart | null = null,
) {
  const made = await createCart(
    env,
    { title: 'Search', flowId, customerId, createdBy: 'usr_ada' },
    ext,
  );
  if (!made.ok) throw new Error(made.error);
  return made.id;
}

const page = async (id: string, q: string, a: CartActor = ada) => {
  const r = await search(id, q, a);
  if (!r.ok) throw new Error(r.error);
  return r;
};

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('searching products from a cart', () => {
  it('finds by name with the price the cart charges its customer, and nothing else', async () => {
    const id = await open();
    const r = await page(id, 'widget');
    expect(r.currency).toBe('USD');
    // Northwind's contract prices, not the 24.00 and 59.00 list prices.
    expect(r.products).toEqual(
      expect.arrayContaining([
        { sku: 'WID-100', name: 'Industrial widget', unitPrice: 21.5 },
        { sku: 'WID-200', name: 'Heavy-duty widget', unitPrice: 52 },
      ]),
    );
    // A result is its SKU, name and price: no cost, stock or supplier.
    for (const p of r.products) expect(Object.keys(p).sort()).toEqual(['name', 'sku', 'unitPrice']);
    // A cart with no customer is charged the list price.
    const anon = await page(await open('tpl-b2b-order', null), 'industrial widget');
    expect(anon.products[0]).toEqual({ sku: 'WID-100', name: 'Industrial widget', unitPrice: 24 });
  });

  it('shows each product at the unit price the cart’s quote then charges for it', async () => {
    // Northwind has contract prices on some of these, the price chain prices the rest.
    const id = await open();
    const shown = (await page(id, '')).products;
    expect(shown.length).toBeGreaterThan(5);
    const agent = env.CART_AGENT.getByName(id);
    for (const p of shown) await agent.applyAs(ada, { op: 'add', sku: p.sku, qty: 1 });
    const quote = (await api().cartSnapshot(id))!.cart!.quote!;
    expect(quote.lines.map((l) => [l.sku, l.unitPrice])).toEqual(
      shown.map((p) => [p.sku, p.unitPrice]),
    );
  });

  it('puts a SKU typed exactly first, matches a word as it is typed, and lists by SKU when empty', async () => {
    const id = await open();
    expect((await page(id, 'GSK-010')).products[0]?.sku).toBe('GSK-010');
    expect((await page(id, 'gask')).products.map((p) => p.sku)).toContain('GSK-010');
    const all = await page(id, '');
    const skus = all.products.map((p) => p.sku);
    expect(skus).toEqual([...skus].sort());
    expect(skus.length).toBeLessThanOrEqual(CART_SEARCH_LIMIT);
    expect(await page(id, 'no such thing at all')).toMatchObject({ products: [], more: false });
  });

  it('treats query syntax as text', async () => {
    const id = await open();
    for (const q of ['"widget', 'name:widget OR *', 'NEAR(a b)', '---', '"'.repeat(500)])
      expect((await search(id, q, ada)).ok).toBe(true);
    // A SKU's parts are words too.
    expect((await page(id, 'wid 100')).products[0]?.sku).toBe('WID-100');
  });

  it('answers a page at most, saying there are more', async () => {
    const id = await open();
    const insert = env.DB.prepare(
      "INSERT INTO products (sku, name, price, cost) VALUES (?, 'Pagination fixture ' || ?, 1, 0.5)",
    );
    await env.DB.batch(
      Array.from({ length: CART_SEARCH_LIMIT + 5 }, (_, i) =>
        insert.bind(`PAGE-${String(i).padStart(2, '0')}`, i),
      ),
    );
    const r = await page(id, 'pagination fixture');
    expect(r.products).toHaveLength(CART_SEARCH_LIMIT);
    expect(r.more).toBe(true);
  });

  it('keeps up with every write to products: new, renamed, restocked and removed', async () => {
    const id = await open();
    await db().insert(products).values({ sku: 'TRG-1', name: 'Lantern brass', price: 9, cost: 4 });
    expect((await page(id, 'lantern')).products.map((p) => p.sku)).toEqual(['TRG-1']);
    await db().update(products).set({ name: 'Copper kettle' }).where(eq(products.sku, 'TRG-1'));
    expect((await page(id, 'lantern')).products).toEqual([]);
    expect((await page(id, 'copper')).products.map((p) => p.sku)).toEqual(['TRG-1']);
    // A stock write leaves the index alone, and the product still found.
    await db().update(products).set({ stock: 40 }).where(eq(products.sku, 'TRG-1'));
    expect((await page(id, 'copper')).products.map((p) => p.sku)).toEqual(['TRG-1']);
    await db().delete(products).where(eq(products.sku, 'TRG-1'));
    expect((await page(id, 'copper')).products).toEqual([]);
  });
});

describe('who may search a cart', () => {
  it('needs someone who may change it, signed for this cart', async () => {
    const id = await open();
    expect(await search(id, 'widget', vee)).toEqual({
      ok: false,
      error: "You can't change this cart.",
    });
    // Signed for another cart: the engine doesn't take it for this one.
    expect(await search(id, 'widget', ada, 'cart_other')).toMatchObject({ ok: false });
    expect(await api().searchCartProducts(id, 'widget', 'forged' as never)).toMatchObject({
      ok: false,
    });
    expect(await search('cart_nope', 'widget', ada)).toMatchObject({ ok: false, notFound: true });
    // A buyer only on the external cart they were admitted to.
    expect(await search(id, 'widget', buyer)).toEqual({
      ok: false,
      error: "You can't change this cart.",
    });
  });

  it('serves the buyer of an external cart while it is open', async () => {
    const id = await open('tpl-b2b-order', 'cus_northwind', external());
    const r = await page(id, 'industrial widget', buyer);
    expect(r.products[0]).toEqual({ sku: 'WID-100', name: 'Industrial widget', unitPrice: 21.5 });
    await env.CART_AGENT.getByName(id).cancelAs(ada);
    expect(await search(id, 'widget', buyer)).toEqual({ ok: false, error: 'The cart has closed.' });
    const lapsed = await open('tpl-b2b-order', null, { ...external(), expiresAt: Date.now() - 1 });
    expect(await search(lapsed, 'widget', buyer)).toEqual({
      ok: false,
      error: 'The cart has closed.',
    });
  });

  it('shows a cost-priced flow’s prices to staff, never to its buyer', async () => {
    // A procurement flow prices at cost: WID-100 costs 11.50.
    const staffCart = await open('tpl-purchase-request', null);
    expect((await page(staffCart, 'industrial widget')).products[0]?.unitPrice).toBe(11.5);
    const buyerCart = await open('tpl-purchase-request', null, external());
    const r = await page(buyerCart, 'industrial widget', buyer);
    expect(r.products[0]).toEqual({ sku: 'WID-100', name: 'Industrial widget', unitPrice: null });
  });
});
