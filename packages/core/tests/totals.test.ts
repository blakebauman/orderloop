import { describe, expect, it } from 'vitest';
import { computeTotals } from '../src';

const lines = [
  { sku: 'A', qty: 2, unitPrice: 10.5 },
  { sku: 'B', qty: 1, unitPrice: 4 },
];

describe('computeTotals', () => {
  it('adds shipping and taxes it when the tax node says so', () => {
    expect(computeTotals({ lines, shipping: 5, taxRate: 0.1, taxShipping: true })).toEqual({
      subtotal: 25,
      shipping: 5,
      tax: 3,
      total: 33,
      baseTotal: 33,
    });
    expect(computeTotals({ lines, shipping: 5, taxRate: 0.1, taxShipping: false })).toMatchObject({
      tax: 2.5,
      total: 32.5,
    });
  });

  it('charges no tax before a tax node runs, and reads missing shipping as 0', () => {
    expect(computeTotals({ lines })).toEqual({
      subtotal: 25,
      shipping: 0,
      tax: 0,
      total: 25,
      baseTotal: 25,
    });
  });

  it('keeps the rate when lines change, instead of inferring it from the old tax', () => {
    const before = computeTotals({ lines, shipping: 6, taxRate: 0.0825, taxShipping: true });
    expect(before.tax).toBe(2.56);
    const after = computeTotals({
      lines: lines.slice(1),
      shipping: 6,
      taxRate: 0.0825,
      taxShipping: true,
    });
    expect(after).toMatchObject({ subtotal: 4, tax: 0.83, total: 10.83 });
  });

  it('converts the total to the base currency at the order’s rate', () => {
    expect(computeTotals({ lines, fxRate: 0.5 }).baseTotal).toBe(50);
  });
});
