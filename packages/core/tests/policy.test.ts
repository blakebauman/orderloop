import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  type Order,
  type PolicyRule,
  policyRulesSchema,
  validateConfig,
} from '../src';

const order = (o: Partial<Order> = {}): Order => ({
  id: 'ord_1',
  model: 'b2c',
  channel: 'web',
  currency: 'USD',
  lines: [{ sku: 'MON-27', qty: 2, unitPrice: 349 }],
  meta: {},
  createdAt: 0,
  subtotal: 698,
  shipping: 0,
  tax: 0,
  total: 698,
  ...o,
});

const rules = (r: unknown[]) => policyRulesSchema.parse(r);
// Wednesday 2026-10-14 15:30 UTC.
const WED_1530 = Date.UTC(2026, 9, 14, 15, 30);

describe('policy rules', () => {
  it('passes an order that meets every rule', () => {
    const r = rules([
      { rule: 'min_order_amount', amount: 25 },
      { rule: 'max_order_amount', amount: 1000 },
      { rule: 'max_qty_per_sku', qty: 10 },
      { rule: 'business_hours', start: 9, end: 17 },
      { rule: 'no_po_box' },
      { rule: 'restricted_skus', skus: ['HAZ-1'] },
    ]);
    expect(evaluatePolicy(r, order({ meta: { shipTo: '1 Main St' } }), WED_1530)).toEqual({
      pass: true,
      failures: [],
    });
  });

  it('reports every failure, not just the first', () => {
    const r = rules([
      { rule: 'min_order_amount', amount: 1000 },
      { rule: 'max_qty_per_sku', qty: 1 },
      { rule: 'restricted_skus', skus: ['MON-27'] },
    ]);
    const res = evaluatePolicy(r, order(), WED_1530);
    expect(res.pass).toBe(false);
    expect(res.failures).toEqual([
      'Minimum order is 1000.00 USD; total is 698.00',
      'More than 1 of MON-27',
      'Restricted SKUs: MON-27',
    ]);
  });

  it('sums quantities across repeated lines of a SKU', () => {
    const o = order({
      lines: [
        { sku: 'GSK-010', qty: 6 },
        { sku: 'GSK-010', qty: 6 },
      ],
    });
    expect(evaluatePolicy(rules([{ rule: 'max_qty_per_sku', qty: 10 }]), o, 0).pass).toBe(false);
  });

  it('applies business hours in the configured time zone', () => {
    const hours = (timeZone: string) =>
      rules([{ rule: 'business_hours', start: 9, end: 17, timeZone }]);
    expect(evaluatePolicy(hours('UTC'), order(), WED_1530).pass).toBe(true);
    // 15:30 UTC is 08:30 in Los Angeles (PDT), before opening.
    expect(evaluatePolicy(hours('America/Los_Angeles'), order(), WED_1530).pass).toBe(false);
    // Saturday is not a default trading day.
    expect(evaluatePolicy(hours('UTC'), order(), WED_1530 + 3 * 86_400_000).pass).toBe(false);
  });

  it('spots PO boxes in string and structured ship-to addresses', () => {
    const r = rules([{ rule: 'no_po_box' }]);
    for (const shipTo of ['PO Box 12, Springfield', 'P.O. Box 9', { line1: 'Post Office Box 4' }])
      expect(evaluatePolicy(r, order({ meta: { shipTo } }), 0).pass).toBe(false);
    expect(evaluatePolicy(r, order({ meta: { shipTo: 'Boxwood Lane 3' } }), 0).pass).toBe(true);
    expect(evaluatePolicy(r, order(), 0).pass).toBe(true);
  });

  it('rejects malformed rules when the flow is validated', () => {
    expect(
      validateConfig('commerce.policy', { rules: [{ rule: 'min_order_amount' }] }),
    ).toHaveLength(1);
    expect(validateConfig('commerce.policy', { rules: [{ rule: 'nope' }] })).toHaveLength(1);
    expect(validateConfig('commerce.policy', { rules: [] })).toHaveLength(1);
    expect(validateConfig('commerce.policy', {})).toEqual([]);
    const ok: PolicyRule[] = [{ rule: 'no_po_box' }];
    expect(validateConfig('commerce.policy', { rules: ok })).toEqual([]);
  });
});
