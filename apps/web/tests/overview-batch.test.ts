import { createDb } from '@orderloop/db';
import { describe, expect, it, vi } from 'vitest';

/** A D1 binding that records each statement's SQL and parameters, and finds nothing. */
const statements: string[] = [];
const params = new Map<string, unknown[]>();
const d1 = {
  prepare: (query: string) => {
    statements.push(query);
    const stmt = {
      bind: (...values: unknown[]) => {
        params.set(query, values);
        return stmt;
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
      first: async () => null,
      run: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt;
  },
  batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [], success: true, meta: {} })),
} as unknown as D1Database;

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => createDb(d1) }));

const { overview } = await import('../app/lib/orders.server');

/** The names a select's result columns come back under: its alias, or the column's own name. */
function resultColumns(query: string): string[] {
  const list = query.slice('select '.length, query.indexOf(' from "'));
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  // SQLite names a column by its alias, a column reference by the column, anything else by its text.
  return parts.map((p) => {
    const part = p.trim();
    return (
      part.match(/ as "([^"]+)"$/)?.[1] ?? part.match(/^(?:"[^"]+"\.)?"([^"]+)"$/)?.[1] ?? part
    );
  });
}

describe('overview', () => {
  // D1's batch returns each row as an object keyed by column name, which drizzle reads back by
  // position: a repeated name drops a column and shifts every one after it.
  it('never selects two result columns with the same name in its batch', async () => {
    statements.length = 0;
    await overview();
    const selects = statements.filter((s) => s.startsWith('select '));
    expect(selects.length).toBeGreaterThan(5);
    for (const s of selects) {
      const cols = resultColumns(s);
      expect(cols, s).toEqual([...new Set(cols)]);
    }
  });

  it('counts a wait as overdue only once its deadline is past, as of the read', async () => {
    statements.length = 0;
    await overview(1_000);
    const waits = statements.find((s) => s.includes('min("waiting_since")'));
    // A null deadline (a timer) compares as null, which the sum skips: never overdue.
    expect(waits).toMatch(/coalesce\(sum\("waiting_due" <= \?\), 0\)/);
    expect(params.get(waits!)).toContain(1_000);
  });

  it("ties each step's latest reason to its own flow and step", async () => {
    statements.length = 0;
    await overview();
    const sub = statements.find((s) => s.includes('select o2.reason'));
    // Unqualified, "flow_id" inside the subquery would be o2's own, matching every row.
    expect(sub).toContain('o2.flow_id = orders.flow_id');
    expect(sub).toContain("coalesce(orders.stopped_at, '')");
  });
});
