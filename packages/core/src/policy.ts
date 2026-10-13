/**
 * Order policy rules for the `commerce.policy` node: the validation and eligibility checks a
 * storefront usually hard-codes (minimum order, per-SKU limits, trading hours, shipping
 * restrictions), stored as data on the node. Pure: the engine passes the order and `now`.
 */

import { z } from 'zod';
import type { Order } from './types';

export const policyRuleSchema = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('min_order_amount'), amount: z.number().nonnegative() }),
  z.object({ rule: z.literal('max_order_amount'), amount: z.number().positive() }),
  z.object({ rule: z.literal('max_qty_per_sku'), qty: z.number().int().positive() }),
  z.object({
    rule: z.literal('business_hours'),
    /** Hours are [start, end) in `timeZone`; days are 0 (Sunday) to 6. */
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(1).max(24),
    days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
    timeZone: z.string().default('UTC'),
  }),
  /** Ship-to in `order.meta.shipTo` (a string or an object of address lines). */
  z.object({ rule: z.literal('no_po_box') }),
  /** SKUs that can't be sold through this flow (hazmat, export-controlled, discontinued). */
  z.object({ rule: z.literal('restricted_skus'), skus: z.array(z.string().min(1)).min(1) }),
]);
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policyRulesSchema = z.array(policyRuleSchema);

export const POLICY_RULES = policyRuleSchema.options.map((o) => o.shape.rule.value);

export type PolicyResult = { pass: boolean; failures: string[] };

const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localTime(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAY[get('weekday')] ?? 0, hour: Number(get('hour')) };
}

function shipTo(order: Order): string {
  const v = order.meta?.shipTo;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object')
    return Object.values(v)
      .filter((x) => typeof x === 'string')
      .join(' ');
  return '';
}

function check(rule: PolicyRule, order: Order, now: number): string | null {
  switch (rule.rule) {
    case 'min_order_amount':
      return order.total < rule.amount
        ? `Minimum order is ${rule.amount.toFixed(2)} ${order.currency}; total is ${order.total.toFixed(2)}`
        : null;
    case 'max_order_amount':
      return order.total > rule.amount
        ? `Maximum order is ${rule.amount.toFixed(2)} ${order.currency}; total is ${order.total.toFixed(2)}`
        : null;
    case 'max_qty_per_sku': {
      const qty = new Map<string, number>();
      for (const l of order.lines) qty.set(l.sku, (qty.get(l.sku) ?? 0) + l.qty);
      const over = [...qty].filter(([, q]) => q > rule.qty).map(([sku]) => sku);
      return over.length ? `More than ${rule.qty} of ${over.join(', ')}` : null;
    }
    case 'business_hours': {
      const { day, hour } = localTime(now, rule.timeZone);
      const open = rule.days.includes(day) && hour >= rule.start && hour < rule.end;
      return open
        ? null
        : `Outside business hours (${rule.start}:00–${rule.end}:00 ${rule.timeZone})`;
    }
    case 'no_po_box':
      return PO_BOX.test(shipTo(order)) ? 'Cannot ship to a PO box' : null;
    case 'restricted_skus': {
      const hit = order.lines.filter((l) => rule.skus.includes(l.sku)).map((l) => l.sku);
      return hit.length ? `Restricted SKUs: ${hit.join(', ')}` : null;
    }
  }
}

/** Runs every rule and collects every failure, so the customer hears about all of them at once. */
export function evaluatePolicy(rules: PolicyRule[], order: Order, now: number): PolicyResult {
  const failures = rules.map((r) => check(r, order, now)).filter((f): f is string => f !== null);
  return { pass: failures.length === 0, failures };
}
