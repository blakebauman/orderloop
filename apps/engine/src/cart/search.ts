/**
 * Finding a product to add to a cart. It searches `products`, the table the cart's quote prices
 * from (the catalog writes its sellable variants there, alongside Order Loop's own rows), so it
 * never offers a product the cart can't price. The words match its keyword index
 * (`products_search`, migration 0058) through core's `ftsQuery`, as the catalog's own search
 * does, so text never reaches FTS5 syntax; a SKU typed exactly comes first.
 *
 * A page shows the unit price the cart's Price lines step charges for one (`unitPrices`), worked
 * out for the cart's customer. A flow that prices at cost shows its buyer none: that would be the
 * supplier's cost of every product the words match, not just the lines they add. What a result
 * carries is its SKU, name and that price; never cost, stock or supplier.
 */

import {
  CART_SEARCH_LIMIT,
  type CartActor,
  type CartAnswer,
  type CartProductPage,
  canEditCart,
  isCartExpired,
  isFinalCart,
} from '@orderloop/core';
import { ftsQuery, normalizeQuery } from '@orderloop/core/product';
import { loadFlowVersion } from '../flows';
import { unitPrices } from '../ucp/quote';
import { cartSnapshot } from './carts';
import { cartDraftExtra, cartSession } from './session';

/** BM25 column weights: SKU, name, as the catalog's search weighs SKUs against titles. */
const WEIGHTS = '8.0, 10.0';

type Row = { sku: string; name: string };

const MAX_TYPED = 200;

/** Up to `limit` + 1 products for `q`: the extra one says there are more. */
async function find(env: Env, q: string, limit: number): Promise<Row[]> {
  // No SKU or name is this long; what's past it is noise, not a longer search.
  const typed = q.trim().slice(0, MAX_TYPED);
  if (!typed)
    return (
      await env.DB.prepare('SELECT sku, name FROM products ORDER BY sku LIMIT ?')
        .bind(limit + 1)
        .all<Row>()
    ).results;
  const exact = env.DB.prepare('SELECT sku, name FROM products WHERE sku = ?').bind(typed);
  const match = ftsQuery(normalizeQuery(typed));
  if (!match) return (await exact.all<Row>()).results;
  // Joined on the SKU, so an index row whose product is gone finds nothing.
  const [bySku, byWords] = await env.DB.batch<Row>([
    exact,
    env.DB.prepare(
      `SELECT p.sku, p.name FROM products_search JOIN products p ON p.sku = products_search.sku
       WHERE products_search MATCH ? ORDER BY bm25(products_search, ${WEIGHTS}), p.sku LIMIT ?`,
    ).bind(match, limit + 1),
  ]);
  const seen = new Set<string>();
  return [...(bySku?.results ?? []), ...(byWords?.results ?? [])]
    .filter((r) => !seen.has(r.sku) && seen.add(r.sku))
    .slice(0, limit + 1);
}

export async function searchCartProducts(
  env: Env,
  cartId: string,
  actor: CartActor,
  q: string,
): Promise<CartAnswer<CartProductPage>> {
  const cart = (await cartSnapshot(env, cartId))?.cart;
  if (!cart) return { ok: false, error: 'No such cart.', notFound: true };
  if (!canEditCart(cart, actor)) return { ok: false, error: "You can't change this cart." };
  if (isFinalCart(cart) || isCartExpired(cart, Date.now()))
    return { ok: false, error: 'The cart has closed.' };
  const flow = await loadFlowVersion(env, cart.flowId);
  if (!flow) return { ok: false, error: 'The cart’s flow is gone.' };
  const rows = await find(env, q, CART_SEARCH_LIMIT);
  const page = rows.slice(0, CART_SEARCH_LIMIT);
  const session = cartSession(cart);
  const priced = await unitPrices(
    env,
    flow,
    session,
    page.map((r) => r.sku),
    cartDraftExtra(cart),
  );
  const shown = priced && !(priced.atCost && actor.kind === 'guest') ? priced.prices : null;
  return {
    ok: true,
    currency: session.currency,
    more: rows.length > CART_SEARCH_LIMIT,
    products: page.map((r) => ({ sku: r.sku, name: r.name, unitPrice: shown?.get(r.sku) ?? null })),
  };
}
