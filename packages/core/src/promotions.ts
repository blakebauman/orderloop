/**
 * Promotions: codes a buyer or staff enter (a cart's codes reach the order as `meta.promoCodes`),
 * applied by the `commerce.discount` node. Pure: the engine reads the `promotions` table and counts
 * redemptions; this decides which codes apply and what they take off.
 *
 * A discount lowers the unit prices of the lines it covers, so the subtotal, tax, invoices and
 * refunds that follow all work from prices already discounted, and nothing else needs to know a
 * discount exists. `free_shipping` takes the order's shipping charge to zero instead.
 */

import { normalizePromoCode } from './cart';
import { fromBase, money, toBase } from './logic';
import type { OrderLine } from './types';

export const PROMOTION_KINDS = ['pct', 'amount', 'free_shipping'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export type Promotion = {
  id: string;
  code: string;
  name: string;
  kind: PromotionKind;
  /** A percentage for `pct`; for `amount`, money in `currency` (or the base currency when null). */
  value: number;
  currency: string | null;
  /** In the base currency, compared with the order's subtotal converted. */
  minSubtotal: number | null;
  /** SKUs it covers; null for every line. */
  skus: string[] | null;
  customerId: string | null;
  validFrom: number | null;
  validTo: number | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  status: 'active' | 'paused';
};

/** The codes an order carries, normalised and once each. */
export function promoCodesOf(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.promoCodes;
  if (!Array.isArray(raw)) return [];
  const codes = raw
    .filter((c): c is string => typeof c === 'string')
    .map(normalizePromoCode)
    .filter((c): c is string => !!c);
  return [...new Set(codes)].slice(0, 10);
}

export type PromotionContext = {
  now: number;
  customerId: string | undefined;
  currency: string;
  fxRate: number | undefined;
  lines: OrderLine[];
  /** Redemptions so far, for the limits: all of them, and this customer's. */
  redeemed: { total: number; byCustomer: number };
};

const eligible = (p: Pick<Promotion, 'skus'>, lines: OrderLine[]) =>
  lines.filter((l) => !p.skus || p.skus.includes(l.sku));

const subtotalOf = (lines: OrderLine[]) =>
  money(lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));

/** What a code that matches no promotion (or one reserved for another customer) is told. */
export const unknownPromotion = (code: string) => `${code} isn't a promotion.`;

/** Why `p` doesn't apply to this order, or null when it does. */
export function promotionProblem(p: Promotion, c: PromotionContext): string | null {
  // Before anything else, and in the same words as a code that doesn't exist, so a buyer can't
  // learn that another customer's code exists (nor that it's paused, upcoming or expired).
  if (p.customerId && p.customerId !== c.customerId) return unknownPromotion(p.code);
  if (p.status !== 'active') return `${p.code} is paused.`;
  if (p.validFrom !== null && c.now < p.validFrom) return `${p.code} isn't valid yet.`;
  if (p.validTo !== null && c.now >= p.validTo) return `${p.code} has expired.`;
  if (p.currency && p.currency !== c.currency) return `${p.code} is for ${p.currency} orders.`;
  if (p.maxRedemptions !== null && c.redeemed.total >= p.maxRedemptions)
    return `${p.code} has been used up.`;
  if (p.perCustomerLimit !== null && c.customerId && c.redeemed.byCustomer >= p.perCustomerLimit)
    return `${p.code} has already been used by this customer.`;
  const lines = eligible(p, c.lines);
  if (!lines.length) return `${p.code} doesn't cover anything in the order.`;
  if (p.minSubtotal !== null && toBase(subtotalOf(c.lines), c.fxRate) < p.minSubtotal)
    return `${p.code} needs a subtotal of at least ${p.minSubtotal}.`;
  return null;
}

export type AppliedPromotion = {
  id: string;
  code: string;
  kind: PromotionKind;
  /** What it took off the lines, in the order's currency (0 for free shipping). */
  amount: number;
};

/** Unit prices keep four decimals; the subtotal is rounded to cents as always. */
const unit = (n: number) => Math.round(n * 10_000) / 10_000;

/** `lines` with `p` applied, and what it took off. Assumes `promotionProblem` found nothing. */
export function applyPromotion(
  p: Promotion,
  lines: OrderLine[],
  c: Pick<PromotionContext, 'fxRate'>,
): { lines: OrderLine[]; amount: number } {
  if (p.kind === 'free_shipping') return { lines, amount: 0 };
  const covered = new Set(eligible(p, lines));
  const base = subtotalOf([...covered]);
  if (base <= 0) return { lines, amount: 0 };
  const off =
    p.kind === 'pct'
      ? money(base * (Math.min(Math.max(p.value, 0), 100) / 100))
      : Math.min(base, p.currency ? money(p.value) : fromBase(p.value, c.fxRate));
  const share = off / base;
  const next = lines.map((l) =>
    covered.has(l) && l.unitPrice !== undefined
      ? { ...l, unitPrice: unit(l.unitPrice * (1 - share)) }
      : l,
  );
  return { lines: next, amount: money(subtotalOf(lines) - subtotalOf(next)) };
}

/**
 * The promotions to apply, in order: every one that applies when `stack` is set (each on the
 * prices the one before left), else the single one that takes off the most (free shipping counts
 * as `shipping`).
 */
export function choosePromotions(
  promos: Promotion[],
  lines: OrderLine[],
  c: Pick<PromotionContext, 'fxRate'> & { shipping: number; stack: boolean },
): Promotion[] {
  if (c.stack || promos.length <= 1) return promos;
  const worth = (p: Promotion) =>
    p.kind === 'free_shipping' ? c.shipping : applyPromotion(p, lines, c).amount;
  return [promos.reduce((best, p) => (worth(p) > worth(best) ? p : best))];
}
