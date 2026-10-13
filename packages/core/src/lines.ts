/**
 * Which order lines a restock covers. Pure: the engine passes what the node's `lines` expression
 * evaluated to (for a return, the lines in the `return.requested` payload) and the order's lines.
 */

import type { OrderLine } from './types';

export type StockLine = { sku: string; qty: number };

/**
 * No list means every ordered line. Otherwise each entry needs a SKU on the order and a positive
 * quantity; quantities are summed per SKU and capped at what was ordered, so a return can never
 * restock more than the order shipped. Anything else is ignored.
 */
export function stockLines(requested: unknown, ordered: OrderLine[]): StockLine[] {
  const limit = new Map<string, number>();
  for (const l of ordered) limit.set(l.sku, (limit.get(l.sku) ?? 0) + l.qty);
  if (requested === undefined || requested === null)
    return [...limit].map(([sku, qty]) => ({ sku, qty }));
  if (!Array.isArray(requested)) return [];

  const want = new Map<string, number>();
  for (const r of requested) {
    if (!r || typeof r !== 'object') continue;
    const { sku, qty } = r as { sku?: unknown; qty?: unknown };
    if (typeof sku !== 'string' || !limit.has(sku)) continue;
    const n = Number(qty);
    if (!(n > 0)) continue;
    want.set(sku, (want.get(sku) ?? 0) + n);
  }
  return [...want].map(([sku, qty]) => ({ sku, qty: Math.min(qty, limit.get(sku)!) }));
}
