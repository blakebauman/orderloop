import { describe, expect, it } from 'vitest';
import {
  capReason,
  failureReason,
  orderReason,
  plural,
  REASON_MAX,
  stockShort,
  varsSummary,
} from '../src/words';

// What D1 through Drizzle threw at the supplier cost step before PR #314: the whole statement and
// its parameters, about 12 KB.
const sqlError = `Failed query: select "sku", "name", "supplier", "cost" from "products" where "products"."sku" in (${Array.from({ length: 400 }, () => '?').join(', ')})\nparams: ${Array.from({ length: 400 }, (_, i) => `SKU-${i}`).join(',')}`;

describe('order reasons', () => {
  it('names where a database error happened, never its statement', () => {
    expect(sqlError.length).toBeGreaterThan(4000);
    expect(failureReason('Supplier cost', sqlError)).toBe('Database error at Supplier cost');
    expect(
      failureReason(
        'Reserve stock',
        'D1_ERROR: too many SQL variables at offset 412: SQLITE_ERROR',
      ),
    ).toBe('Database error at Reserve stock');
  });

  it('keeps a plain error’s first line, without a stack', () => {
    expect(
      failureReason(
        'Reserve stock',
        'Insufficient stock for WID-100\n    at reserve (nodes.ts:10:5)',
      ),
    ).toBe('Reserve stock: Insufficient stock for WID-100');
    expect(failureReason('Charge', '')).toBe('Charge failed');
  });

  it('caps a long reason at a word, with an ellipsis', () => {
    const long = failureReason('Notify', `Carrier said ${'no '.repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(REASON_MAX);
    expect(long).toMatch(/^Notify: Carrier said no no .*no…$/);
    // One unbroken token is cut where it has to be.
    expect(capReason('x'.repeat(500))).toBe(`${'x'.repeat(REASON_MAX - 1)}…`);
    expect(capReason('  Short\n reason  ')).toBe('Short reason');
  });

  it('cuts a reported reason back to where a database error happened', () => {
    expect(orderReason(`Supplier cost: ${sqlError}`)).toBe('Database error at Supplier cost');
    expect(orderReason(sqlError)).toBe('Database error');
    expect(orderReason('No approval decision in time')).toBe('No approval decision in time');
    expect(orderReason(`Returned: ${'x '.repeat(300)}`).length).toBeLessThanOrEqual(REASON_MAX);
  });

  it('counts in words', () => {
    expect(plural(1, 'reservation')).toBe('1 reservation');
    expect(plural(0, 'authorization')).toBe('0 authorizations');
    expect(plural(3, 'SKU')).toBe('3 SKUs');
  });

  it("reads a step's variables as words, leaving out empty ones", () => {
    expect(varsSummary({ cycle: 2 })).toBe('Cycle 2');
    expect(varsSummary({ cycle: 0, year: null })).toBe('Cycle 0');
    expect(varsSummary({ next_tier: 'gold', limit: 5 })).toBe('Next tier gold, Limit 5');
    expect(varsSummary({ year: null })).toBe('Nothing set');
  });

  it('says a line is out of stock rather than "only 0"', () => {
    expect(stockShort('Organic cotton tee', 0)).toBe('Organic cotton tee is out of stock.');
    expect(stockShort('Organic cotton tee', 2)).toBe('Only 2 of Organic cotton tee are available.');
  });
});
