import { describe, expect, it } from 'vitest';
import { type PriceRule, type PriceSource, resolvePrice } from '../src/pricing';

const sources: PriceSource[] = [
  { id: 'price_book', label: 'Price books', priority: 10, stopProcessing: true },
  { id: 'contract', label: 'Contract prices', priority: 20, stopProcessing: true },
  { id: 'volume', label: 'Volume tiers', priority: 30, stopProcessing: false },
];
const now = Date.UTC(2026, 9, 13);
const ctx = { customerId: 'cus_a', customerTier: 'gold', now };
const line = (sku: string, qty: number) => ({ sku, qty });

describe('resolvePrice', () => {
  it('falls back to the list price', () => {
    expect(resolvePrice(line('W', 1), 10, sources, [], ctx)).toEqual({
      unitPrice: 10,
      by: { source: 'list', ruleId: null, name: 'List price' },
    });
  });

  it('stops at the first matching source that stops processing', () => {
    const rules: PriceRule[] = [
      { id: 'c', source: 'contract', name: 'Contract', customerId: 'cus_a', sku: 'W', price: 9 },
      { id: 'v', source: 'volume', name: '100+', sku: 'W', minQty: 100, price: 7 },
    ];
    // The contract stops the chain, so the cheaper volume tier is never reached...
    expect(resolvePrice(line('W', 200), 10, sources, rules, ctx).by.ruleId).toBe('c');
    // ...unless the contract doesn't stop, and then the lowest candidate wins.
    const open = sources.map((s) => ({ ...s, stopProcessing: false }));
    expect(resolvePrice(line('W', 200), 10, open, rules, ctx)).toMatchObject({
      unitPrice: 7,
      by: { source: 'volume', ruleId: 'v' },
    });
    // A contract above list price still wins: it is what was agreed.
    const high: PriceRule[] = [{ ...rules[0]!, price: 11 }];
    expect(resolvePrice(line('W', 1), 10, sources, high, ctx).unitPrice).toBe(11);
  });

  it('runs sources by priority, so a price book outranks a contract', () => {
    const rules: PriceRule[] = [
      { id: 'b', source: 'price_book', name: 'Gold book', customerTier: 'gold', discountPct: 5 },
      { id: 'c', source: 'contract', name: 'Contract', customerId: 'cus_a', sku: 'W', price: 8 },
    ];
    expect(resolvePrice(line('W', 1), 10, sources, rules, ctx)).toMatchObject({
      unitPrice: 9.5,
      by: { source: 'price_book', ruleId: 'b' },
    });
    const contractFirst = sources.map((s) => (s.id === 'contract' ? { ...s, priority: 1 } : s));
    expect(resolvePrice(line('W', 1), 10, contractFirst, rules, ctx).unitPrice).toBe(8);
  });

  it('takes the deepest matching volume tier and respects every scope', () => {
    const rules: PriceRule[] = [
      { id: 'v100', source: 'volume', name: '100+', sku: 'W', minQty: 100, discountPct: 5 },
      { id: 'v500', source: 'volume', name: '500+', sku: 'W', minQty: 500, discountPct: 12 },
      { id: 'other', source: 'volume', name: 'Other SKU', sku: 'X', price: 1 },
      { id: 'silver', source: 'volume', name: 'Silver', customerTier: 'silver', price: 1 },
      { id: 'later', source: 'volume', name: 'Next year', startsAt: now + 1, price: 1 },
      { id: 'ended', source: 'volume', name: 'Last year', endsAt: now, price: 1 },
      { id: 'empty', source: 'volume', name: 'No action' },
    ];
    expect(resolvePrice(line('W', 99), 10, sources, rules, ctx).by.source).toBe('list');
    expect(resolvePrice(line('W', 100), 10, sources, rules, ctx).unitPrice).toBe(9.5);
    expect(resolvePrice(line('W', 750), 10, sources, rules, ctx)).toMatchObject({
      unitPrice: 8.8,
      by: { ruleId: 'v500' },
    });
  });

  it('skips sources that are not in the chain', () => {
    const rules: PriceRule[] = [{ id: 'c', source: 'contract', name: 'Contract', price: 1 }];
    const noContract = sources.filter((s) => s.id !== 'contract');
    expect(resolvePrice(line('W', 1), 10, noContract, rules, ctx).by.source).toBe('list');
  });
});
