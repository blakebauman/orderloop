import { createDb } from '@orderloop/db';
import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_SIZE,
  LIST_SIZE,
  lastPage,
  pageHref,
  pageOf,
  shown,
  storeKey,
} from '../app/lib/commerce-pages';

/** A D1 binding that records each statement, counts 1,000 of everything and has two stores. */
const statements: string[] = [];
const d1 = {
  prepare: (query: string) => {
    statements.push(query);
    const rows = query.includes('count(*)')
      ? [[1000]]
      : query.includes('from "locations"')
        ? [
            ['loc_a', 'A store', 'store', '', 1, 1, null, null],
            ['loc_b', 'B store', 'store', '', 1, 0, null, null],
          ]
        : query.includes('from "price_sources"')
          ? [
              ['contract', 'Contract prices', 20, 1, 1],
              ['volume', 'Volume tiers', 30, 0, 1],
            ]
          : [];
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => rows,
      first: async () => null,
      run: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt;
  },
  batch: async () => [],
} as unknown as D1Database;

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => createDb(d1) }));

const { commercePage } = await import('../app/lib/commerce.server');

describe('Commerce paging', () => {
  it('reads a page from the URL, and anything else as the first', () => {
    const p = new URLSearchParams('inventory=3&customers=0&sellers=x&store-loc_a=2.5');
    expect(pageOf(p, 'inventory')).toBe(3);
    expect(pageOf(p, 'customers')).toBe(1);
    expect(pageOf(p, 'sellers')).toBe(1);
    expect(pageOf(p, storeKey('loc_a'))).toBe(1);
    expect(pageOf(p, 'missing')).toBe(1);
  });

  it('links to another page of one list, keeping the search and the other lists', () => {
    const p = new URLSearchParams('q=widget&store-loc_a=2');
    expect(pageHref(p, 'inventory', 3, 'stock')).toBe('?q=widget&store-loc_a=2&inventory=3#stock');
    expect(pageHref(p, storeKey('loc_a'), 1, 'stores')).toBe('?q=widget#stores');
    expect(pageHref(new URLSearchParams(), 'inventory', 1, 'stock')).toBe('/commerce#stock');
  });

  it('says which rows a page shows, and how many pages there are', () => {
    expect(shown({ page: 1, size: 25, total: 2000 })).toEqual({ first: 1, last: 25 });
    expect(shown({ page: 80, size: 25, total: 2000 })).toEqual({ first: 1976, last: 2000 });
    expect(shown({ page: 2, size: 10, total: 13 })).toEqual({ first: 11, last: 13 });
    expect(lastPage(0, 25)).toBe(1);
    expect(lastPage(2000, 25)).toBe(80);
    expect(lastPage(2001, 25)).toBe(81);
  });

  it('reads every list a page at a time, and a page past the end as the last', async () => {
    statements.length = 0;
    const page = await commercePage(new URLSearchParams('inventory=999&store-loc_b=4'));
    expect(page.inventory).toMatchObject({ total: 1000, page: 40, size: LIST_SIZE });
    expect(page.stores.map((s) => s.stock.page)).toEqual([1, 4]);
    expect(page.pricing.sources.map((s) => s.entries.size)).toEqual([GROUP_SIZE, GROUP_SIZE]);
    const lists = statements.filter(
      (s) =>
        !s.includes('count(*)') &&
        /from "(products|customers|sellers|location_stock|contract_prices|price_rules)"/.test(s),
    );
    // Inventory, customers, sellers, two stores and two pricing sources.
    expect(lists).toHaveLength(7);
    for (const s of lists) expect(s, s).toMatch(/ limit \?( offset \?)?$/);
    // Unqualified, the subquery's `sku` would be its own column and every row would match.
    expect(statements.find((s) => s.includes('from location_stock ls'))).toContain(
      'ls.sku = products.sku',
    );
  });
});
