import {
  type EdgeState,
  type FlowGraph,
  isBackEdge,
  type NodeRun,
  type NodeStatus,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import {
  approvals,
  contains,
  contractPrices,
  customers,
  type Db,
  documents,
  entitlements,
  flows,
  fxRates,
  getFlowVersionJson,
  inboundEmails,
  invoices,
  locationStock,
  locations,
  messages,
  nodeRuns,
  orders,
  payments,
  payouts,
  priceRules,
  priceSources,
  products,
  reservations,
  sellerOrders,
  sellers,
  shipments,
} from '@orderloop/db';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { OrderCursor } from './cursor';
import { db } from './env.server';
import { plural } from './format';
import { SCENARIO_CUSTOMERS, SCENARIO_SKUS } from './scenarios';

export type OrderFilters = {
  model?: string;
  channel?: string;
  status?: string;
  q?: string;
  /**
   * Newest first by default. "oldest" is created ascending, "updated" most recent first, "total"
   * largest first in the base currency, and "waiting" the longest-held first (orders not waiting
   * last).
   */
  sort?: 'created' | 'oldest' | 'updated' | 'total' | 'waiting';
  /** Only what needs a person: failed, rolled back, or waiting on a pending approval. */
  attention?: boolean;
  /** Only orders on this flow, any version. */
  flow?: string;
  /** Only orders waiting at, or stopped at, this step (by its label). */
  step?: string;
  /** Only orders updated within this window: for ended orders, ended within it. */
  within?: Within;
  /** Newest-first paging: only orders created before the previous page's last row. */
  after?: OrderCursor;
};

/**
 * An order the engine runs: the engine names its Workflow instance in the index when it starts the
 * order. A recorded order (one `pnpm db:seed:volume` wrote straight into the index) has none, so
 * nothing can resume it: it is never live work. No live count, queue or open-status filter includes
 * it, and a list shows its open status as "Recorded" (`liveStatus` in format.ts).
 */
const hasRun = isNotNull(orders.instanceId);

/** Open statuses: an order in one is live work only while it has a run. */
const OPEN_STATUSES = ['queued', 'running', 'waiting'];

export const WITHIN = { '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
export type Within = keyof typeof WITHIN;
export const isWithin = (v: string | null): v is Within => !!v && v in WITHIN;

export async function listOrders(f: OrderFilters = {}, limit = 200) {
  return ordersQuery(db(), f, limit);
}

/** The most orders `countOrders` counts; past it the list says "10,000+". */
export const COUNT_CAP = 10_000;

/**
 * How many orders a filter picks across every page, for the list's "Newest 200 of 960". It reads
 * at most `cap + 1` rows, so a large index costs the same as a capped one; `more` says there were
 * more than `cap`.
 */
export async function countOrders(f: OrderFilters = {}, cap = COUNT_CAP) {
  const { after: _, ...filters } = f;
  const picked = db()
    .select({ one: sql<number>`1`.as('one') })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(ordersWhere(filters))
    .limit(cap + 1)
    .as('picked');
  const row = await db().select({ n: sql<number>`count(*)` }).from(picked).get();
  const n = Number(row?.n ?? 0);
  return { n: Math.min(n, cap), more: n > cap };
}

/** The orders a filter picks, as a query to run alone or in a batch. */
function ordersQuery(d: Db, f: OrderFilters, limit: number) {
  const order =
    f.sort === 'oldest'
      ? [asc(orders.createdAt), asc(orders.id)]
      : f.sort === 'total'
        ? [desc(sql`${orders.total} / ${orders.fxRate}`), desc(orders.id)]
        : f.sort === 'updated'
          ? [desc(orders.updatedAt), desc(orders.id)]
          : f.sort === 'waiting'
            ? [sql`${orders.waitingSince} is null`, asc(orders.waitingSince), desc(orders.id)]
            : [desc(orders.createdAt), desc(orders.id)];
  return d
    .select(getTableColumns(orders))
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(ordersWhere(f))
    .orderBy(...order)
    .limit(limit);
}

/** What a filter picks; `q` also matches the customer's name, so the query joins customers. */
function ordersWhere(f: OrderFilters) {
  // "#idz7qp" is how the app writes an order's reference (`orderRef`); search its id without the #.
  const q = f.q?.trim().replace(/^#/, '');
  return and(
    f.after
      ? or(
          lt(orders.createdAt, f.after.createdAt),
          and(eq(orders.createdAt, f.after.createdAt), lt(orders.id, f.after.id)),
        )
      : undefined,
    f.model ? eq(orders.model, f.model) : undefined,
    f.channel ? eq(orders.channel, f.channel) : undefined,
    f.flow ? eq(orders.flowId, f.flow) : undefined,
    // A step's label as the index stores it: one label, or several joined with " · ".
    f.step
      ? or(
          eq(orders.waitingAt, f.step),
          eq(orders.stoppedAt, f.step),
          contains(orders.waitingAt, f.step),
          contains(orders.stoppedAt, f.step),
        )
      : undefined,
    f.within ? gte(orders.updatedAt, Date.now() - WITHIN[f.within]) : undefined,
    f.status === 'declined'
      ? // Orders declined before `declined` existed were stored as cancelled (see `orderStatus`).
        or(eq(orders.status, 'declined'), inArray(orders.id, declinedIds()))
      : f.status
        ? and(eq(orders.status, f.status), OPEN_STATUSES.includes(f.status) ? hasRun : undefined)
        : undefined,
    f.attention
      ? or(
          inArray(orders.status, ['failed', 'rolled_back']),
          and(
            hasRun,
            inArray(
              orders.id,
              db()
                .select({ id: approvals.orderId })
                .from(approvals)
                .where(eq(approvals.status, 'pending')),
            ),
          ),
        )
      : undefined,
    q
      ? or(
          contains(orders.id, q),
          contains(orders.title, q),
          contains(orders.customerId, q),
          contains(customers.name, q),
          contains(orders.contactEmail, q),
          contains(orders.externalId, q),
        )
      : undefined,
  );
}

/**
 * Everything the overview reads from D1, in one round trip (a D1 batch): open orders by status,
 * the most recently updated orders, pending approvals, what ended in the last 24 hours, where open
 * orders wait (by flow and step) and what failed or rolled back this week (by flow and step).
 */
export async function overview(now = Date.now()) {
  const d = db();
  const stopped = inArray(orders.status, ['failed', 'rolled_back']);
  const dayAgo = now - WITHIN['24h'];
  const weekAgo = now - WITHIN['7d'];
  const [open, recent, approvalRows, ended24h, declined24h, waitsByFlow, stoppedWeek] =
    await d.batch([
      // Open work as it is now.
      d
        .select({ status: orders.status, n: sql<number>`count(*)` })
        .from(orders)
        .where(and(inArray(orders.status, OPEN_STATUSES), hasRun))
        .groupBy(orders.status),
      ordersQuery(d, { sort: 'updated' }, 8),
      // The longest-waiting few that can be decided; the queue's size comes with them.
      approvalsQuery(d, 'pending', { scope: 'live', limit: 5 }),
      // What ended in the last 24 hours, by status (an ended order's last update is its end).
      d
        .select({
          status: orders.status,
          n: sql<number>`count(*)`,
          total: sql<number>`coalesce(sum(${orders.total} / ${orders.fxRate}), 0)`,
        })
        .from(orders)
        .where(and(inArray(orders.status, TERMINAL_ORDER_STATUSES), gte(orders.updatedAt, dayAgo)))
        .groupBy(orders.status),
      d
        .select({ n: sql<number>`count(distinct ${approvals.orderId})` })
        .from(approvals)
        .innerJoin(orders, eq(orders.id, approvals.orderId))
        .where(and(declinedWhere, gte(orders.updatedAt, dayAgo))),
      // Where open orders wait, by flow and step, with the oldest wait and how many are overdue.
      d
        .select({
          flowId: orders.flowId,
          at: orders.waitingAt,
          for: orders.waitingFor,
          n: sql<number>`count(*)`,
          oldest: sql<number | null>`min(${orders.waitingSince})`,
          overdue: sql<number>`coalesce(sum(${orders.waitingDue} <= ${now}), 0)`,
        })
        .from(orders)
        .where(and(eq(orders.status, 'waiting'), hasRun))
        .groupBy(orders.flowId, orders.waitingAt, orders.waitingFor),
      // Where orders ended badly this week, by flow and step, with the latest reason. Grouped in
      // SQL; the reason is the newest order's, picked by the max-updatedAt row of each group. The
      // outer columns are written `orders.…` by hand: drizzle prints them unqualified, which inside
      // the subquery would mean o2's own and give every group the week's newest reason.
      d
        .select({
          flowId: orders.flowId,
          at: orders.stoppedAt,
          n: sql<number>`count(*)`,
          rolledBack: sql<number>`sum(${orders.status} = 'rolled_back')`,
          latest: sql<number>`max(${orders.updatedAt})`,
          reason: sql<
            string | null
          >`(select o2.reason from orders o2 where o2.flow_id = orders.flow_id and coalesce(o2.stopped_at, '') = coalesce(orders.stopped_at, '') and o2.status in ('failed', 'rolled_back') and o2.updated_at >= ${weekAgo} order by o2.updated_at desc limit 1)`,
        })
        .from(orders)
        .where(and(stopped, gte(orders.updatedAt, weekAgo)))
        .groupBy(orders.flowId, orders.stoppedAt)
        .orderBy(sql`count(*) desc`),
    ]);
  return {
    open,
    recent,
    approvals: approvalRows,
    pendingApprovals: approvalRows[0]?.total ?? 0,
    ended24h,
    declined24h: declined24h[0]?.n ?? 0,
    waitsByFlow,
    stoppedWeek,
  };
}

/** How many approvals the inbox shows at once; each costs one read of its order's live state. */
export const APPROVALS_PAGE = 50;

/** Where a page of approvals ended: the last row's request time and id (ids break ties). */
export type ApprovalCursor = { requestedAt: number; id: string };

/**
 * Which approvals, by their order: those on orders with a run, which a decision resumes (`live`),
 * or those on recorded orders, which nothing can decide (`recorded`). Unset, every approval.
 */
export type ApprovalScope = 'live' | 'recorded';

/** The approvals a scope picks, over a query that joins `orders` (left: a missing one is recorded). */
const inScope = (scope?: ApprovalScope) =>
  scope === 'live' ? hasRun : scope === 'recorded' ? isNull(orders.instanceId) : undefined;

/**
 * One page of the approvals inbox, with how many rows match and how many came before this page.
 * Pending approvals read oldest request first (the longest wait is the most urgent); history reads
 * newest first. Pages are keyed by the last row, so a decision taken meanwhile shifts nothing. The
 * queue reads the `live` scope, so every row on it can be decided; approvals on recorded orders are
 * a scope of their own that the inbox folds into one line (`pendingApprovalCounts`).
 */
export async function listApprovals(
  status = 'pending',
  after: ApprovalCursor | null = null,
  limit = APPROVALS_PAGE,
  scope?: ApprovalScope,
) {
  const d = db();
  const later = status === 'pending' ? gt : lt;
  const past = after
    ? or(
        later(approvals.requestedAt, after.requestedAt),
        and(eq(approvals.requestedAt, after.requestedAt), later(approvals.id, after.id)),
      )
    : undefined;
  const page = approvalsQuery(d, status, { where: past, scope, limit: limit + 1 });
  // How many rows the pages before this one held, so the page can say where it starts.
  const [rows, before] = past
    ? await d.batch([
        page,
        d
          .select({ n: sql<number>`count(*)` })
          .from(approvals)
          .leftJoin(orders, eq(orders.id, approvals.orderId))
          .where(
            and(
              status === 'all' ? undefined : eq(approvals.status, status),
              inScope(scope),
              not(past),
            ),
          ),
      ])
    : [await page, [{ n: 0 }]];
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  const from = before[0]?.n ?? 0;
  return {
    rows: shown,
    from,
    total: rows[0]?.total ?? from,
    next: rows.length > limit && last ? { requestedAt: last.requestedAt, id: last.id } : null,
  };
}

/**
 * Pending approvals, split by whether a decision can resume their order: `live` is the queue the
 * nav badge and the overview count, `recorded` the ones on orders with no run.
 */
export async function pendingApprovalCounts() {
  const row = await db()
    .select({
      live: sql<number>`coalesce(sum(${orders.instanceId} is not null), 0)`,
      recorded: sql<number>`coalesce(sum(${orders.instanceId} is null), 0)`,
    })
    .from(approvals)
    .leftJoin(orders, eq(orders.id, approvals.orderId))
    .where(eq(approvals.status, 'pending'))
    .get();
  return { live: Number(row?.live ?? 0), recorded: Number(row?.recorded ?? 0) };
}

function approvalsQuery(
  d: Db,
  status: string,
  { where, scope, limit }: { where?: SQL; scope?: ApprovalScope; limit: number },
) {
  const matching = status === 'all' ? sql`1` : sql`q.status = ${status}`;
  const scoped =
    scope === 'live'
      ? sql` and o.instance_id is not null`
      : scope === 'recorded'
        ? sql` and o.instance_id is null`
        : sql``;
  return d
    .select({
      id: approvals.id,
      orderId: approvals.orderId,
      nodeId: approvals.nodeId,
      title: approvals.title,
      assignee: approvals.assignee,
      amount: approvals.amount,
      status: approvals.status,
      note: approvals.note,
      requestedAt: approvals.requestedAt,
      decidedAt: approvals.decidedAt,
      decidedBy: approvals.decidedBy,
      orderModel: orders.model,
      // Aliased: D1's batch returns rows keyed by column name, so a second `title` would overwrite
      // the approval's and shift every later column (the overview's currency became a customer id).
      orderTitle: sql<string | null>`${orders.title}`.as('order_title'),
      // The approval step's label from the flow version the order pinned, so a row still names
      // its step when the order's live state can't be read.
      stepLabel: sql<
        string | null
      >`(select json_extract(n.value, '$.label') from flow_versions fv, json_each(fv.flow_json, '$.nodes') n where fv.flow_id = orders.flow_id and fv.version = orders.flow_version and json_extract(n.value, '$.id') = approvals.node_id limit 1)`.as(
        'step_label',
      ),
      currency: orders.currency,
      customerId: orders.customerId,
      customerName: customers.name,
      fxRate: orders.fxRate,
      startedBy: orders.startedBy,
      // How many approvals have this status (in this scope), so a short list can count the rest.
      // Uncorrelated, so SQLite counts once from the status index; a window count would read every
      // matching row.
      total: (scope
        ? sql<number>`(select count(*) from approvals q left join orders o on o.id = q.order_id where ${matching}${scoped})`
        : status === 'all'
          ? sql<number>`(select count(*) from approvals)`
          : sql<number>`(select count(*) from approvals q where q.status = ${status})`
      ).as('total'),
    })
    .from(approvals)
    .leftJoin(orders, eq(orders.id, approvals.orderId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(and(status === 'all' ? undefined : eq(approvals.status, status), inScope(scope), where))
    .orderBy(
      ...(status === 'pending'
        ? [asc(approvals.requestedAt), asc(approvals.id)]
        : [desc(approvals.requestedAt), desc(approvals.id)]),
    )
    .limit(limit);
}

/** An order's D1 records, in one round trip (a D1 batch). */
export async function orderRecords(orderId: string) {
  const d = db();
  const [docs, msgs, pays, ships, parts, outs, bills] = await d.batch([
    d
      .select()
      .from(documents)
      .where(eq(documents.orderId, orderId))
      .orderBy(desc(documents.createdAt)),
    d
      .select()
      .from(messages)
      .where(eq(messages.orderId, orderId))
      .orderBy(desc(messages.createdAt)),
    d
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(desc(payments.createdAt)),
    d
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .orderBy(desc(shipments.createdAt)),
    d
      .select({
        sellerId: sellerOrders.sellerId,
        name: sellers.name,
        status: sellerOrders.status,
        subtotal: sellerOrders.subtotal,
        reason: sellerOrders.reason,
      })
      .from(sellerOrders)
      .leftJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
      .where(eq(sellerOrders.orderId, orderId))
      .orderBy(sellerOrders.sellerId),
    d
      .select({
        sellerId: payouts.sellerId,
        name: sellers.name,
        status: payouts.status,
        net: payouts.net,
        commission: payouts.commission,
      })
      .from(payouts)
      .leftJoin(sellers, eq(sellers.id, payouts.sellerId))
      .where(eq(payouts.orderId, orderId))
      .orderBy(payouts.sellerId),
    d
      .select({
        id: invoices.id,
        status: invoices.status,
        number: invoices.number,
        hostedUrl: invoices.hostedUrl,
        amount: invoices.amount,
        currency: invoices.currency,
        dueAt: invoices.dueAt,
      })
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
      .orderBy(desc(invoices.createdAt)),
  ]);
  return {
    documents: docs,
    messages: msgs,
    payments: pays,
    shipments: ships,
    sellers: parts.map((p) => ({ ...p, name: p.name ?? 'Marketplace' })),
    payouts: outs,
    invoices: bills,
  };
}

/**
 * A recorded order's graph colours: each step's last recorded run, and the steps it is waiting at
 * (named in `waitingAt`) while it hasn't ended.
 */
export function recordedRuns(
  graph: FlowGraph | null,
  steps: { nodeId: string; status: string; run: number; startedAt: number; endedAt: number }[],
  order: { status: string; waitingAt: string | null; waitingSince: number | null },
): Record<string, NodeRun> {
  const runs: Record<string, NodeRun> = {};
  for (const r of steps)
    runs[r.nodeId] = {
      status: r.status as NodeStatus,
      runs: r.run,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    };
  if (TERMINAL_ORDER_STATUSES.includes(order.status as never)) return runs;
  const waitingAt = new Set(order.waitingAt?.split(' · ') ?? []);
  for (const n of graph?.nodes ?? [])
    if (waitingAt.has(n.label))
      runs[n.id] = { status: 'waiting', runs: 1, startedAt: order.waitingSince ?? undefined };
  return runs;
}

/**
 * The path a recorded order took, inked as the live view inks it. `node_runs` keeps no branches, so
 * an edge counts as taken when its source finished and its target ran. On an order that has ended,
 * every other edge was not taken; on an open one, an edge is untaken only when its source took
 * another branch, and the rest may still be taken.
 */
export function recordedEdges(
  graph: FlowGraph | null,
  runs: Record<string, NodeRun>,
  order: { status: string },
): Record<string, EdgeState> {
  const ended = TERMINAL_ORDER_STATUSES.includes(order.status as never);
  const finished = (id: string) => ['succeeded', 'rolled_back'].includes(runs[id]?.status ?? '');
  const ran = (id: string) => !!runs[id] && runs[id].status !== 'skipped';
  const taken = (e: FlowGraph['edges'][number]) =>
    finished(e.source) &&
    ran(e.target) &&
    // Going round a loop again means its target ran more than once.
    (!isBackEdge(e) || (runs[e.target]?.runs ?? 0) > 1);
  const edges = graph?.edges ?? [];
  const states: Record<string, EdgeState> = {};
  for (const e of edges) {
    if (taken(e)) states[e.id] = 'active';
    else if (ended) states[e.id] = 'inactive';
    else {
      const handle = e.sourceHandle || 'out';
      const otherBranch = edges.some(
        (o) => o.source === e.source && (o.sourceHandle || 'out') !== handle && taken(o),
      );
      states[e.id] = otherBranch || runs[e.source]?.status === 'skipped' ? 'inactive' : 'pending';
    }
  }
  return states;
}

/** What each compensation leaves in D1, counted for one order (see `undoneOn`). */
export type Undone = {
  reservationsReleased: number;
  authorizationsVoided: number;
  sellerOrdersCancelled: number;
  payoutsReversed: number;
  shipmentsCancelled: number;
  invoicesVoided: number;
  codesRevoked: number;
};

/**
 * The step types whose compensation (the engine's `ROLLBACKS`) leaves a record behind, and how the
 * record reads. A step whose compensation leaves nothing countable (a promotion given back) isn't
 * here, so it is never shown as reversed on a guess.
 */
const REVERSALS: Record<string, { undone: keyof Undone; say: (n: number) => string }> = {
  'commerce.reserve_inventory': {
    undone: 'reservationsReleased',
    say: (n) => `Released ${plural(n, 'stock reservation')}`,
  },
  'commerce.authorize_payment': {
    undone: 'authorizationsVoided',
    say: (n) => `Voided ${plural(n, 'payment authorization')}`,
  },
  'commerce.split_by_seller': {
    undone: 'sellerOrdersCancelled',
    say: (n) => `Cancelled ${plural(n, 'seller order')}`,
  },
  'commerce.payout': { undone: 'payoutsReversed', say: (n) => `Reversed ${plural(n, 'payout')}` },
  'commerce.ship': {
    undone: 'shipmentsCancelled',
    say: (n) => `Cancelled ${plural(n, 'shipment')}`,
  },
  'commerce.pickup_ready': {
    undone: 'shipmentsCancelled',
    say: (n) => `Cancelled ${plural(n, 'pickup')}`,
  },
  'commerce.invoice': { undone: 'invoicesVoided', say: (n) => `Voided ${plural(n, 'invoice')}` },
  'commerce.deliver_digital': {
    undone: 'codesRevoked',
    say: (n) => `Revoked ${plural(n, 'digital code')}`,
  },
};

/**
 * What a rolled-back order's records show was undone, tied to the step that did it: the last step
 * of each reversible type whose last run succeeded, when its records were reversed. Records alone don't say
 * which of two steps of one type made them, so they go to the last one to run.
 */
export function recordedReversals(
  steps: { nodeId: string; type: string; status: string; startedAt: number }[],
  undone: Undone,
): { nodeId: string; text: string }[] {
  const lastRun = new Map<string, (typeof steps)[number]>();
  for (const st of [...steps].sort((a, b) => a.startedAt - b.startedAt)) lastRun.set(st.nodeId, st);
  const last = new Map<string, string>();
  for (const st of lastRun.values())
    if (st.status === 'succeeded' && REVERSALS[st.type]) last.set(st.type, st.nodeId);
  const claimed = new Set<keyof Undone>();
  const out: { nodeId: string; text: string }[] = [];
  for (const [type, nodeId] of last) {
    const r = REVERSALS[type]!;
    const n = undone[r.undone];
    if (!n || claimed.has(r.undone)) continue;
    claimed.add(r.undone);
    out.push({ nodeId, text: r.say(n) });
  }
  return out;
}

/** Counts what the compensations left on one order's records, in one round trip. */
async function undoneOn(orderId: string): Promise<Undone> {
  const d = db();
  const n = sql<number>`count(*)`.mapWith(Number);
  const [res, pays, parts, outs, ships, bills, codes] = await d.batch([
    d
      .select({ n })
      .from(reservations)
      .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'released'))),
    d
      .select({ n })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'voided'))),
    d
      .select({ n })
      .from(sellerOrders)
      .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'cancelled'))),
    d
      .select({ n })
      .from(payouts)
      .where(and(eq(payouts.orderId, orderId), eq(payouts.status, 'reversed'))),
    d
      .select({ n })
      .from(shipments)
      .where(and(eq(shipments.orderId, orderId), eq(shipments.status, 'cancelled'))),
    d
      .select({ n })
      .from(invoices)
      .where(and(eq(invoices.orderId, orderId), eq(invoices.status, 'void'))),
    d
      .select({ n })
      .from(entitlements)
      .where(and(eq(entitlements.orderId, orderId), eq(entitlements.status, 'revoked'))),
  ]);
  return {
    reservationsReleased: res[0]?.n ?? 0,
    authorizationsVoided: pays[0]?.n ?? 0,
    sellerOrdersCancelled: parts[0]?.n ?? 0,
    payoutsReversed: outs[0]?.n ?? 0,
    shipmentsCancelled: ships[0]?.n ?? 0,
    invoicesVoided: bills[0]?.n ?? 0,
    codesRevoked: codes[0]?.n ?? 0,
  };
}

/**
 * An order the orders index has but the engine has no run for (one `pnpm db:seed:volume`
 * generated, say): what D1 recorded, for a read-only page. The flow is the version it ran on;
 * `runs` colours its graph by each step's last recorded run, and the steps it is waiting at, and
 * `edges` inks the path it took. A rolled-back order also says what its records show was undone,
 * and those steps read as rolled back.
 */
export async function recordedOrder(orderId: string) {
  const d = db();
  const order = await d.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;
  const rolledBack = order.status === 'rolled_back';
  const [version, steps, asks, undone] = await Promise.all([
    getFlowVersionJson(d, order.flowId, order.flowVersion ?? undefined),
    d
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.orderId, orderId), eq(nodeRuns.generation, order.generation ?? 1)))
      .orderBy(asc(nodeRuns.startedAt)),
    d
      .select()
      .from(approvals)
      .where(eq(approvals.orderId, orderId))
      .orderBy(asc(approvals.requestedAt)),
    rolledBack ? undoneOn(orderId) : null,
  ]);
  const flow = version
    ? {
        name: version.flow.name,
        version: version.version,
        graph: { nodes: version.flow.nodes, edges: version.flow.edges } as FlowGraph,
      }
    : null;
  const label = (id: string) => flow?.graph.nodes.find((n) => n.id === id)?.label ?? id;
  const runs = recordedRuns(flow?.graph ?? null, steps, order);
  const reversed = undone
    ? recordedReversals(
        steps.map((r) => ({ ...r, type: r.nodeType })),
        undone,
      ).map((r) => ({ ...r, label: label(r.nodeId) }))
    : [];
  const undoneIds = new Set(reversed.map((r) => r.nodeId));
  for (const id of undoneIds) if (runs[id]) runs[id] = { ...runs[id], status: 'rolled_back' };
  // Only a step's last run was reversed; an earlier run of it had already ended.
  const lastRun = new Map(steps.map((r) => [r.nodeId, r]));
  return {
    order,
    flow,
    runs,
    edges: recordedEdges(flow?.graph ?? null, runs, order),
    steps: steps.map((r) => ({
      nodeId: r.nodeId,
      label: label(r.nodeId),
      type: r.nodeType,
      status: undoneIds.has(r.nodeId) && lastRun.get(r.nodeId) === r ? 'rolled_back' : r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
    })),
    approvals: asks,
    /** Null unless the order rolled back; empty when its records show nothing undone. */
    reversed: rolledBack ? reversed : null,
  };
}

export async function getOrderRow(orderId: string) {
  return db().select().from(orders).where(eq(orders.id, orderId)).get();
}

export async function commerceData() {
  const [cust, prods, sources, rules, contracts, sellerRows, stores, storeStock] =
    await Promise.all([
      db().select().from(customers).orderBy(customers.name),
      db().select().from(products).orderBy(products.sku),
      db().select().from(priceSources).orderBy(priceSources.priority),
      db()
        .select()
        .from(priceRules)
        .orderBy(priceRules.sourceId, priceRules.sku, priceRules.minQty),
      db().select().from(contractPrices).orderBy(contractPrices.customerId, contractPrices.sku),
      db().select().from(sellers).orderBy(sellers.name),
      db().select().from(locations).orderBy(locations.name),
      db().select().from(locationStock).orderBy(locationStock.sku),
    ]);
  return {
    customers: cust,
    sellers: sellerRows,
    stores: stores.map((l) => ({ ...l, stock: storeStock.filter((s) => s.locationId === l.id) })),
    products: prods,
    pricing: { sources, rules, contracts, rates: await currencies() },
  };
}

/**
 * Orders with a run waiting on an outside event (the index's `waiting_for` names one), the `limit`
 * most recently updated, and how many there are in all.
 */
export async function waitingOnEvents(limit: number) {
  const d = db();
  // Only orders with a run: the list reads each one's live waits, and a recorded order has none.
  const where = and(
    inArray(orders.status, ['waiting', 'running']),
    contains(orders.waitingFor, 'event:'),
    hasRun,
  );
  const [rows, all] = await d.batch([
    d.select().from(orders).where(where).orderBy(desc(orders.updatedAt)).limit(limit),
    d.select({ n: sql<number>`count(*)` }).from(orders).where(where),
  ]);
  return { orders: rows, total: Number(all[0]?.n ?? rows.length) };
}

export async function publishedFlows() {
  return db()
    .select({
      id: flows.id,
      name: flows.name,
      model: flows.model,
      version: flows.publishedVersion,
    })
    .from(flows)
    .where(sql`${flows.publishedVersion} is not null`)
    .orderBy(flows.name);
}

/** Orders still running (queued, running or waiting) per flow and version, for the flows list. */
export async function runningByFlow(): Promise<Record<string, Record<number, number>>> {
  const rows = await db()
    .select({ flowId: orders.flowId, version: orders.flowVersion, n: sql<number>`count(*)` })
    .from(orders)
    .where(and(inArray(orders.status, OPEN_STATUSES), hasRun))
    .groupBy(orders.flowId, orders.flowVersion);
  const out: Record<string, Record<number, number>> = {};
  for (const r of rows) {
    out[r.flowId] ??= {};
    out[r.flowId]![r.version] = r.n;
  }
  return out;
}

/** Each published flow with the graph orders on it will run, for the new-order form. */
export async function publishedFlowGraphs() {
  const list = await publishedFlows();
  return Promise.all(
    list.map(async (f) => {
      const v = await getFlowVersionJson(db(), f.id, f.version ?? undefined);
      const graph = { nodes: v?.flow.nodes ?? [], edges: v?.flow.edges ?? [] } as FlowGraph;
      return { ...f, graph };
    }),
  );
}

/**
 * `ids` in runs that fit one D1 statement, which binds at most 100 parameters; 90 leaves room for
 * the rest of the query's. A list page passes up to 200 ids.
 */
function batches<T>(ids: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Display names for the given customer ids, for lists that only carry the id. */
export async function customerNames(
  ids: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return {};
  const rows = await Promise.all(
    batches(wanted).map((b) =>
      db()
        .select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(inArray(customers.id, b)),
    ),
  );
  return Object.fromEntries(rows.flat().map((r) => [r.id, r.name]));
}

/**
 * Cancelled orders that were declined by policy (their approval was rejected or escalated) rather
 * than cancelled by a person. The index keeps one status; the approvals table says which.
 */
export async function declinedOrderIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await Promise.all(
    batches(ids).map((b) =>
      db()
        .selectDistinct({ id: approvals.orderId })
        .from(approvals)
        .innerJoin(orders, eq(orders.id, approvals.orderId))
        .where(and(declinedWhere, inArray(approvals.orderId, b))),
    ),
  );
  return new Set(rows.flat().map((r) => r.id));
}

const declinedWhere = and(
  inArray(approvals.status, ['escalated', 'rejected']),
  eq(orders.status, 'cancelled'),
);

/** The ids of cancelled orders declined by policy, as a subquery. */
const declinedIds = () =>
  db()
    .select({ id: approvals.orderId })
    .from(approvals)
    .innerJoin(orders, eq(orders.id, approvals.orderId))
    .where(declinedWhere);

/** The email intake log: every message the engine's email() entrypoint saw, newest first. */
export async function recentInboundEmails(limit = 20) {
  return db().select().from(inboundEmails).orderBy(desc(inboundEmails.receivedAt)).limit(limit);
}

/** Currencies an order can be in: those with a rate, base first. */
export async function currencies() {
  const rows = await db().select().from(fxRates).orderBy(fxRates.currency);
  return rows.sort((a, b) => Number(b.rate === 1) - Number(a.rate === 1));
}

/** The customer a channel's buyer email belongs to, for orders that arrive without an id. */
export async function customerIdByEmail(email: string | null | undefined) {
  if (!email) return undefined;
  const row = await db()
    .select({ id: customers.id })
    .from(customers)
    .where(sql`lower(${customers.email}) = ${email.trim().toLowerCase()}`)
    .get();
  return row?.id;
}

let demo: { value: boolean; at: number } | null = null;

/**
 * Whether the demo data (`packages/db/seed`) is loaded: every customer and SKU the demo scenarios
 * use exists. Production has none of it, so the scenarios are hidden there. Remembered for a
 * minute per isolate.
 */
export async function demoAvailable(): Promise<boolean> {
  if (demo && Date.now() - demo.at < 60_000) return demo.value;
  const [c, p] = await Promise.all([
    db()
      .select({ n: sql<number>`count(*)` })
      .from(customers)
      .where(inArray(customers.id, SCENARIO_CUSTOMERS))
      .get(),
    db()
      .select({ n: sql<number>`count(*)` })
      .from(products)
      .where(inArray(products.sku, SCENARIO_SKUS))
      .get(),
  ]);
  const value = c?.n === SCENARIO_CUSTOMERS.length && p?.n === SCENARIO_SKUS.length;
  demo = { value, at: Date.now() };
  return value;
}
