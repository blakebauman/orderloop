import { createDb } from '@orderloop/db';
import { describe, expect, it, vi } from 'vitest';

/** A D1 binding that records how many parameters each statement binds, and finds nothing. */
const bound: number[] = [];
const statements: { sql: string; params: unknown[] }[] = [];
const d1 = {
  prepare: (sql: string) => {
    const stmt = {
      bind: (...params: unknown[]) => {
        bound.push(params.length);
        statements.push({ sql, params });
        return stmt;
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
      first: async () => null,
      run: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt;
  },
  batch: async () => [],
} as unknown as D1Database;

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => createDb(d1) }));

const { countOrders, customerNames, declinedOrderIds } = await import('../app/lib/orders.server');

// The orders list asks about a page of 200.
const ids = Array.from({ length: 200 }, (_, i) => `id${i}`);

describe('list lookups stay under D1’s 100 bound parameters', () => {
  it('declinedOrderIds', async () => {
    bound.length = 0;
    await declinedOrderIds(ids);
    expect(bound.length).toBeGreaterThan(1);
    expect(Math.max(...bound)).toBeLessThanOrEqual(100);
  });

  it('customerNames', async () => {
    bound.length = 0;
    await customerNames(ids);
    expect(bound.length).toBeGreaterThan(1);
    expect(Math.max(...bound)).toBeLessThanOrEqual(100);
  });
});

describe('countOrders', () => {
  it('counts every page a filter picks, reading at most one row past the cap', async () => {
    statements.length = 0;
    const counted = await countOrders(
      { status: 'failed', q: 'ada', after: { createdAt: 1, id: 'ord_x' } },
      50,
    );
    expect(counted).toEqual({ n: 0, more: false });
    const [stmt] = statements;
    expect(stmt!.sql).toMatch(
      /^select count\(\*\) from \(select 1 as "one" from "orders" left join "customers"/,
    );
    // The page's cursor is not a filter: the count is of the whole list.
    expect(stmt!.sql).not.toContain('"created_at" <');
    expect(stmt!.params).toContain('failed');
    expect(stmt!.params.at(-1)).toBe(51);
  });
});
