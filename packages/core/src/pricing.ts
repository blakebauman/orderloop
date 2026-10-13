/**
 * The pricing chain for `commerce.price`. Pure: the engine loads the sources and their entries from
 * D1 and passes them in with the list price.
 *
 * Sources run in `priority` order (lowest first). Within a source, the lowest price among its
 * matching entries counts, so the deepest volume tier wins. Each source that matches adds that
 * price as a candidate, and a matching source with `stopProcessing` ends the chain. The line takes
 * the lowest candidate; with none, the list price.
 */

export const PRICE_SOURCES = ['price_book', 'contract', 'volume'] as const;
export type PriceSourceKind = (typeof PRICE_SOURCES)[number];

export type PriceSource = {
  id: PriceSourceKind;
  label: string;
  priority: number;
  stopProcessing: boolean;
};

/** One entry in a source. Empty scope fields match anything. */
export type PriceRule = {
  id: string;
  source: PriceSourceKind;
  name: string;
  sku?: string | null;
  customerId?: string | null;
  customerTier?: string | null;
  /** The line's quantity must be at least this. */
  minQty?: number | null;
  /** A fixed unit price, or else `discountPct` off the list price. */
  price?: number | null;
  discountPct?: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
};

export type PriceContext = {
  customerId?: string | null;
  customerTier?: string | null;
  now: number;
};

export type PricedBy =
  | { source: PriceSourceKind; ruleId: string; name: string }
  | { source: 'list'; ruleId: null; name: 'List price' };

export type ResolvedPrice = { unitPrice: number; by: PricedBy };

const LIST: PricedBy = { source: 'list', ruleId: null, name: 'List price' };

const round = (n: number) => Math.round(n * 100) / 100;

export function matchesRule(
  r: PriceRule,
  line: { sku: string; qty: number },
  ctx: PriceContext,
): boolean {
  if (r.sku && r.sku !== line.sku) return false;
  if (r.customerId && r.customerId !== ctx.customerId) return false;
  if (r.customerTier && r.customerTier !== ctx.customerTier) return false;
  if (r.minQty && line.qty < r.minQty) return false;
  if (r.startsAt && ctx.now < r.startsAt) return false;
  if (r.endsAt && ctx.now >= r.endsAt) return false;
  return r.price != null || r.discountPct != null;
}

function priceOf(r: PriceRule, listPrice: number) {
  if (r.price != null) return round(r.price);
  return round(listPrice * (1 - (r.discountPct ?? 0) / 100));
}

export function resolvePrice(
  line: { sku: string; qty: number },
  listPrice: number,
  sources: PriceSource[],
  rules: PriceRule[],
  ctx: PriceContext,
): ResolvedPrice {
  let best: ResolvedPrice | null = null;
  const ordered = [...sources].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const source of ordered) {
    let mine: ResolvedPrice | null = null;
    for (const r of rules) {
      if (r.source !== source.id || !matchesRule(r, line, ctx)) continue;
      const unitPrice = priceOf(r, listPrice);
      if (!mine || unitPrice < mine.unitPrice)
        mine = { unitPrice, by: { source: source.id, ruleId: r.id, name: r.name } };
    }
    if (!mine) continue;
    if (!best || mine.unitPrice < best.unitPrice) best = mine;
    if (source.stopProcessing) break;
  }
  return best ?? { unitPrice: listPrice, by: LIST };
}
