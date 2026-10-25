import { createDb } from '@orderloop/db';
import { describe, expect, it, vi } from 'vitest';

/** A D1 binding that records how many parameters each statement binds, and finds nothing. */
const bound: number[] = [];
const d1 = {
  prepare: () => {
    const stmt = {
      bind: (...params: unknown[]) => {
        bound.push(params.length);
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

const { customerNames, declinedOrderIds } = await import('../app/lib/orders.server');

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
