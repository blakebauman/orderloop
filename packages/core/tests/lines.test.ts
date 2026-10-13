import { describe, expect, it } from 'vitest';
import { stockLines } from '../src/lines';

const ordered = [
  { sku: 'MON-27', qty: 2 },
  { sku: 'GSK-010', qty: 5 },
  { sku: 'MON-27', qty: 1 },
];

describe('stockLines', () => {
  it('restocks every ordered line, merged per SKU, when no list is given', () => {
    expect(stockLines(undefined, ordered)).toEqual([
      { sku: 'MON-27', qty: 3 },
      { sku: 'GSK-010', qty: 5 },
    ]);
    expect(stockLines(null, ordered)).toEqual(stockLines(undefined, ordered));
  });

  it('restocks only the listed lines, capped at what was ordered', () => {
    expect(
      stockLines(
        [
          { sku: 'MON-27', qty: 1 },
          { sku: 'GSK-010', qty: 9 },
        ],
        ordered,
      ),
    ).toEqual([
      { sku: 'MON-27', qty: 1 },
      { sku: 'GSK-010', qty: 5 },
    ]);
  });

  it('ignores SKUs not on the order, bad quantities and non-lists', () => {
    expect(
      stockLines(
        [
          { sku: 'LAP-14', qty: 1 },
          { sku: 'MON-27', qty: 0 },
          { sku: 'MON-27', qty: 'two' },
          { sku: 'GSK-010', qty: '2' },
          null,
          'MON-27',
        ],
        ordered,
      ),
    ).toEqual([{ sku: 'GSK-010', qty: 2 }]);
    expect(stockLines('everything', ordered)).toEqual([]);
    expect(stockLines([], ordered)).toEqual([]);
  });
});
