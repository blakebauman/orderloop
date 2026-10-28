import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from '@orderloop/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approvals inbox's queries against real SQLite with the D1 schema applied: paging, counts and
 * the step label come from SQL (a keyset, a window count, a lookup in the pinned flow's JSON), so a
 * fake binding that finds nothing can't check them.
 */
let sqlite: DatabaseSync;

/** The slice of a D1 binding drizzle uses, over node:sqlite. */
const d1 = {
  prepare(query: string) {
    const make = (params: unknown[]) => {
      const stmt = () => sqlite.prepare(query);
      const args = params as never[];
      return {
        bind: (...p: unknown[]) => make(p),
        all: async () => ({ results: stmt().all(...args), success: true, meta: {} }),
        raw: async () =>
          stmt()
            .all(...args)
            .map((r) => Object.values(r as object)),
        first: async () => stmt().get(...args) ?? null,
        run: async () => {
          stmt().run(...args);
          return { results: [], success: true, meta: {} };
        },
      };
    };
    return make([]);
  },
  batch: async (stmts: { all: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.all())),
} as unknown as D1Database;

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => createDb(d1) }));

const { listApprovals, overview } = await import('../app/lib/orders.server');

const MIGRATIONS = new URL('../../../packages/db/migrations/', import.meta.url);

const flowJson = JSON.stringify({
  id: 'f_buy',
  nodes: [
    { id: 'mgr', type: 'control.approval', label: 'Manager approval' },
    { id: 'fin', type: 'control.approval', label: 'Finance approval' },
  ],
  edges: [],
});

/** An order on version 1 of `f_buy` with one approval at `node`, requested at `at`. */
function approval(id: string, at: number, status = 'pending', node = 'mgr', version = 1) {
  sqlite
    .prepare(
      `insert into orders (id, model, status, flow_id, flow_version, created_at, updated_at)
       values (?, 'procurement', 'waiting', 'f_buy', ?, ?, ?)`,
    )
    .run(`ord_${id}`, version, at, at);
  sqlite
    .prepare(
      `insert into approvals (id, order_id, node_id, event_type, title, status, requested_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`apr_${id}`, `ord_${id}`, node, `approval-${node}`, `Approve ord_${id}`, status, at);
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  sqlite
    .prepare(
      `insert into flows (id, name, model, graph_json, created_at, updated_at)
       values ('f_buy', 'Buy', 'procurement', '{"nodes":[],"edges":[]}', 0, 0)`,
    )
    .run();
  sqlite
    .prepare(
      `insert into flow_versions (flow_id, version, flow_json, published_at) values ('f_buy', 1, ?, 0)`,
    )
    .run(flowJson);
});

describe('listApprovals', () => {
  it('pages pending approvals oldest first, with where each page starts and the way on', async () => {
    // Two requests at the same moment: the id breaks the tie, so neither is skipped or repeated.
    for (const [id, at] of [
      ['a', 100],
      ['b', 200],
      ['c', 200],
      ['d', 300],
      ['e', 400],
    ] as const)
      approval(id, at);
    approval('x', 50, 'approved');

    const one = await listApprovals('pending', null, 2);
    expect(ids(one.rows)).toEqual(['apr_a', 'apr_b']);
    expect(one).toMatchObject({ from: 0, total: 5, next: { requestedAt: 200, id: 'apr_b' } });

    const two = await listApprovals('pending', one.next, 2);
    expect(ids(two.rows)).toEqual(['apr_c', 'apr_d']);
    expect(two).toMatchObject({ from: 2, total: 5 });

    const three = await listApprovals('pending', two.next, 2);
    expect(ids(three.rows)).toEqual(['apr_e']);
    expect(three).toMatchObject({ from: 4, total: 5, next: null });
  });

  it('keeps a later page in place when a row before it is decided', async () => {
    for (const [id, at] of [
      ['a', 100],
      ['b', 200],
      ['c', 300],
      ['d', 400],
    ] as const)
      approval(id, at);
    const one = await listApprovals('pending', null, 2);
    sqlite.prepare(`update approvals set status = 'approved' where id = 'apr_a'`).run();
    const two = await listApprovals('pending', one.next, 2);
    // An offset would now skip apr_c; the keyset starts after the last row shown.
    expect(ids(two.rows)).toEqual(['apr_c', 'apr_d']);
    expect(two).toMatchObject({ from: 1, total: 3, next: null });
  });

  it('reads history newest first', async () => {
    approval('a', 100, 'approved');
    approval('b', 200, 'rejected');
    approval('c', 300, 'pending');
    const all = await listApprovals('all', null, 2);
    expect(ids(all.rows)).toEqual(['apr_c', 'apr_b']);
    const rest = await listApprovals('all', all.next, 2);
    expect(ids(rest.rows)).toEqual(['apr_a']);
    expect(rest).toMatchObject({ from: 2, total: 3, next: null });
  });

  it("names each approval's step from the flow version its order pinned", async () => {
    approval('a', 100, 'pending', 'fin');
    // A version that isn't stored (or a step it doesn't have) leaves the label empty, not wrong.
    approval('b', 200, 'pending', 'mgr', 9);
    const { rows } = await listApprovals('pending', null, 10);
    expect(rows.map((r) => r.stepLabel)).toEqual(['Finance approval', null]);
    expect(rows[0]!.title).toBe('Approve ord_a');
  });

  it('starts past the end with nothing left and still counts what came before', async () => {
    approval('a', 100);
    const page = await listApprovals('pending', { requestedAt: 100, id: 'apr_a' }, 2);
    expect(page).toMatchObject({ rows: [], from: 1, total: 1, next: null });
  });
});

describe('overview', () => {
  it('reads the five longest-waiting approvals and counts the whole queue', async () => {
    for (let i = 0; i < 8; i++) approval(`p${i}`, 1000 - i * 10);
    approval('done', 1, 'approved');
    const o = await overview();
    expect(ids(o.approvals)).toEqual(['apr_p7', 'apr_p6', 'apr_p5', 'apr_p4', 'apr_p3']);
    expect(o.pendingApprovals).toBe(8);
  });
});
