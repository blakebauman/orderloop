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

const { listApprovals, listOrders, overview, pendingApprovalCounts, waitingOnEvents } =
  await import('../app/lib/orders.server');

const MIGRATIONS = new URL('../../../packages/db/migrations/', import.meta.url);

const flowJson = JSON.stringify({
  id: 'f_buy',
  nodes: [
    { id: 'mgr', type: 'control.approval', label: 'Manager approval' },
    { id: 'fin', type: 'control.approval', label: 'Finance approval' },
  ],
  edges: [],
});

/**
 * An order on version 1 of `f_buy` with one approval at `node`, requested at `at`. The engine names
 * its run in the index; a recorded order (`run` false, as `pnpm db:seed:volume` writes them) has none.
 */
function approval(
  id: string,
  at: number,
  status = 'pending',
  node = 'mgr',
  version = 1,
  run = true,
) {
  sqlite
    .prepare(
      `insert into orders (id, model, status, flow_id, flow_version, instance_id, waiting_at,
         waiting_for, waiting_since, waiting_due, created_at, updated_at)
       values (?, 'procurement', 'waiting', 'f_buy', ?, ?, 'Manager approval', 'person:manager',
         ?, ?, ?, ?)`,
    )
    .run(`ord_${id}`, version, run ? `ord_${id}-g1` : null, at, at + 10, at, at);
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
    // And its flow, which the inbox groups by alongside the step.
    expect(rows[0]).toMatchObject({ flowId: 'f_buy', flowName: 'Buy' });
  });

  it('starts past the end with nothing left and still counts what came before', async () => {
    approval('a', 100);
    const page = await listApprovals('pending', { requestedAt: 100, id: 'apr_a' }, 2);
    expect(page).toMatchObject({ rows: [], from: 1, total: 1, next: null });
  });
});

describe('approvals on recorded orders', () => {
  it('keeps them out of the queue and its count, and lists them on their own', async () => {
    // Recorded ones are the oldest, so a queue sorted only by age would open on them.
    approval('r1', 10, 'pending', 'mgr', 1, false);
    approval('r2', 20, 'pending', 'mgr', 1, false);
    approval('r3', 30, 'pending', 'mgr', 1, false);
    approval('a', 100);
    approval('b', 200);
    approval('c', 300);

    const live = await listApprovals('pending', null, 2, 'live');
    expect(ids(live.rows)).toEqual(['apr_a', 'apr_b']);
    expect(live).toMatchObject({ from: 0, total: 3 });
    const rest = await listApprovals('pending', live.next, 2, 'live');
    expect(ids(rest.rows)).toEqual(['apr_c']);
    // Where the page starts counts only this scope's rows, not the recorded ones before it.
    expect(rest).toMatchObject({ from: 2, total: 3, next: null });

    const recorded = await listApprovals('pending', null, 2, 'recorded');
    expect(ids(recorded.rows)).toEqual(['apr_r1', 'apr_r2']);
    expect(recorded).toMatchObject({ total: 3 });
    const more = await listApprovals('pending', recorded.next, 2, 'recorded');
    expect(ids(more.rows)).toEqual(['apr_r3']);
    expect(more).toMatchObject({ from: 2, total: 3, next: null });

    expect(await pendingApprovalCounts()).toEqual({ live: 3, recorded: 3 });
  });

  it('counts an approval whose order is missing as recorded, and history as it was', async () => {
    approval('a', 100);
    approval('gone', 200);
    sqlite.prepare(`delete from orders where id = 'ord_gone'`).run();
    approval('old', 50, 'approved', 'mgr', 1, false);
    expect(await pendingApprovalCounts()).toEqual({ live: 1, recorded: 1 });
    // History has no scope: what was decided on a recorded order is still history.
    expect(ids((await listApprovals('all', null, 10)).rows)).toEqual([
      'apr_gone',
      'apr_a',
      'apr_old',
    ]);
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

  it('leaves recorded orders out of open work, waits and decisions', async () => {
    approval('live', 100);
    approval('rec', 50, 'pending', 'mgr', 1, false);
    const o = await overview(1_000);
    expect(ids(o.approvals)).toEqual(['apr_live']);
    expect(o.pendingApprovals).toBe(1);
    expect(o.open).toEqual([{ status: 'waiting', n: 1 }]);
    // One wait, past its deadline: the recorded one's is too, but it isn't counted at all.
    expect(o.waitsByFlow).toMatchObject([{ n: 1, overdue: 1 }]);
  });
});

describe('recorded orders in lists', () => {
  it("leaves them out of an open status's list and of what needs attention", async () => {
    approval('live', 100);
    approval('rec', 50, 'pending', 'mgr', 1, false);
    expect(ids(await listOrders({ status: 'waiting' }))).toEqual(['ord_live']);
    expect(ids(await listOrders({ attention: true }))).toEqual(['ord_live']);
    // Unfiltered, the list still has every order; it shows the recorded one as recorded.
    expect(ids(await listOrders())).toEqual(['ord_live', 'ord_rec']);
  });

  it('counts and lists only orders with a run as waiting on an outside event', async () => {
    approval('live', 100);
    approval('rec', 50, 'pending', 'mgr', 1, false);
    sqlite.prepare(`update orders set waiting_for = 'event:payment.received'`).run();
    const waiting = await waitingOnEvents(10);
    expect(ids(waiting.orders)).toEqual(['ord_live']);
    expect(waiting.total).toBe(1);
  });
});
