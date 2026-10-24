/**
 * The catalog's half of Order Loop's `products` table (D1): one row per variant SKU, whose name
 * and list price the catalog keeps current. Stock, reservations, cost, reorder settings, seller and
 * kind stay Order Loop's own, so the engine's pricing, reservations and replenishment read exactly
 * what they always did.
 *
 * Only one channel feeds it: ORDERS_CHANNEL (default `web`), in BASE_CURRENCY, which is what an
 * order's list prices are in. A variant without a price there isn't written. A product that stops
 * being listed keeps its rows: orders may name its SKUs. Changes can arrive out of order, so a row
 * records when the catalog wrote it (`catalog_at`) and only a newer change applies.
 */
import { BASE_CURRENCY, fromMinor } from '@orderloop/core';
import { type Channel, type Product, type ProductType, pickLocale } from '@orderloop/core/product';
import type { ListingChange } from './listings';

/** One variant as an order line sees it. */
export type OrderLine = { sku: string; name: string; price: number };

/** The variants of `product` an order can name, priced in BASE_CURRENCY for `channel`. */
export function orderLines(product: Product, type: ProductType, channel: Channel): OrderLine[] {
  if (channel.currency !== BASE_CURRENCY) return [];
  const listing = product.channels[channel.code];
  const fallback = channel.defaultLocale;
  const title = pickLocale(product.title, fallback, fallback) ?? product.key;
  const axes = type.variantAxes.map((code) => type.attributes.find((a) => a.code === code));
  const out: OrderLine[] = [];
  for (const v of product.variants) {
    if (v.status !== 'active') continue;
    const price =
      v.prices?.[channel.code]?.currency === BASE_CURRENCY
        ? v.prices[channel.code]
        : listing?.price?.currency === BASE_CURRENCY
          ? listing.price
          : undefined;
    if (!price) continue;
    const options = axes
      .map((def) => {
        if (!def) return undefined;
        const code = v.attributes[def.code];
        if (typeof code !== 'string') return undefined;
        const label = def.values?.find((x) => x.code === code)?.label;
        return pickLocale(label, fallback, fallback) ?? code;
      })
      .filter((o): o is string => !!o);
    out.push({
      sku: v.sku,
      name: options.length ? `${title} (${options.join(', ')})` : title,
      price: fromMinor(price.amount, BASE_CURRENCY),
    });
  }
  return out;
}

const UPSERT = `INSERT INTO products (sku, name, price, cost, catalog_at) VALUES (?, ?, ?, 0, ?)
  ON CONFLICT (sku) DO UPDATE SET name = excluded.name, price = excluded.price,
    catalog_at = excluded.catalog_at
  WHERE products.catalog_at IS NULL OR products.catalog_at < excluded.catalog_at`;

/** Writes the order lines a batch of changes carries, newest change per SKU winning. */
export async function applyOrders(env: Env, changes: ListingChange[]): Promise<void> {
  const latest = new Map<string, { line: OrderLine; at: number }>();
  for (const c of changes)
    for (const line of c.order ?? []) {
      const seen = latest.get(line.sku);
      if (!seen || seen.at < c.at) latest.set(line.sku, { line, at: c.at });
    }
  if (!latest.size) return;
  const statements = [...latest.values()].map(({ line, at }) =>
    env.DB.prepare(UPSERT).bind(line.sku, line.name, line.price, at),
  );
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
}
