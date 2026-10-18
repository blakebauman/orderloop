import type { FlowGraph } from '@orderloop/core';
import {
  approvals,
  contains,
  contractPrices,
  customers,
  documents,
  flows,
  fxRates,
  getFlowVersionJson,
  inboundEmails,
  invoices,
  locationStock,
  locations,
  messages,
  orders,
  payments,
  payouts,
  priceRules,
  priceSources,
  products,
  sellerOrders,
  sellers,
  shipments,
} from '@orderloop/db';
import { and, asc, desc, eq, getTableColumns, inArray, lt, or, sql } from 'drizzle-orm';
import type { OrderCursor } from './cursor';
import { db } from './env.server';
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
  /** Newest-first paging: only orders created before the previous page's last row. */
  after?: OrderCursor;
};

export async function listOrders(f: OrderFilters = {}, limit = 200) {
  // "#idz7qp" is how the app writes an order's reference (`orderRef`); search its id without the #.
  const q = f.q?.trim().replace(/^#/, '');
  const where = and(
    f.after
      ? or(
          lt(orders.createdAt, f.after.createdAt),
          and(eq(orders.createdAt, f.after.createdAt), lt(orders.id, f.after.id)),
        )
      : undefined,
    f.model ? eq(orders.model, f.model) : undefined,
    f.channel ? eq(orders.channel, f.channel) : undefined,
    f.status === 'declined'
      ? // Orders declined before `declined` existed were stored as cancelled (see `orderStatus`).
        or(eq(orders.status, 'declined'), inArray(orders.id, declinedIds()))
      : f.status
        ? eq(orders.status, f.status)
        : undefined,
    f.attention
      ? or(
          inArray(orders.status, ['failed', 'rolled_back']),
          inArray(
            orders.id,
            db()
              .select({ id: approvals.orderId })
              .from(approvals)
              .where(eq(approvals.status, 'pending')),
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
  return db()
    .select(getTableColumns(orders))
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(where)
    .orderBy(...order)
    .limit(limit);
}

export async function dashboardStats() {
  const [byStatus, byModel, pending] = await Promise.all([
    db()
      .select({
        status: orders.status,
        n: sql<number>`count(*)`,
        // In the base currency, at each order's rate.
        total: sql<number>`coalesce(sum(${orders.total} / ${orders.fxRate}), 0)`,
      })
      .from(orders)
      .groupBy(orders.status),
    db()
      .select({ model: orders.model, n: sql<number>`count(*)` })
      .from(orders)
      .groupBy(orders.model),
    db()
      .select({ n: sql<number>`count(*)` })
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
      .get(),
  ]);
  return { byStatus, byModel, pendingApprovals: pending?.n ?? 0 };
}

export async function listApprovals(status = 'pending') {
  return db()
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
      orderTitle: orders.title,
      currency: orders.currency,
      customerId: orders.customerId,
      customerName: customers.name,
      fxRate: orders.fxRate,
      startedBy: orders.startedBy,
    })
    .from(approvals)
    .leftJoin(orders, eq(orders.id, approvals.orderId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(status === 'all' ? undefined : eq(approvals.status, status))
    .orderBy(desc(approvals.requestedAt))
    .limit(200);
}

export async function orderRecords(orderId: string) {
  const [docs, msgs, pays, ships, parts, outs, bills] = await Promise.all([
    db()
      .select()
      .from(documents)
      .where(eq(documents.orderId, orderId))
      .orderBy(desc(documents.createdAt)),
    db()
      .select()
      .from(messages)
      .where(eq(messages.orderId, orderId))
      .orderBy(desc(messages.createdAt)),
    db()
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(desc(payments.createdAt)),
    db()
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .orderBy(desc(shipments.createdAt)),
    db()
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
    db()
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
    db()
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

export async function getOrderRow(orderId: string) {
  return db().select().from(orders).where(eq(orders.id, orderId)).get();
}

export async function backOffice() {
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

export async function waitingOrders() {
  return db()
    .select()
    .from(orders)
    .where(
      and(inArray(orders.status, ['waiting', 'running']), sql`${orders.waitingOn} is not null`),
    )
    .orderBy(desc(orders.updatedAt))
    .limit(50);
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

/** Display names for the given customer ids, for lists that only carry the id. */
export async function customerNames(
  ids: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return {};
  const rows = await db()
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(inArray(customers.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/**
 * Cancelled orders that were declined by policy (their approval was rejected or escalated) rather
 * than cancelled by a person. The index keeps one status; the approvals table says which.
 */
export async function declinedOrderIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db()
    .selectDistinct({ id: approvals.orderId })
    .from(approvals)
    .innerJoin(orders, eq(orders.id, approvals.orderId))
    .where(and(declinedWhere, inArray(approvals.orderId, ids)));
  return new Set(rows.map((r) => r.id));
}

/** How many cancelled orders were declined by policy, for the overview's counts. */
export async function declinedCount(): Promise<number> {
  const row = await db()
    .select({ n: sql<number>`count(distinct ${approvals.orderId})` })
    .from(approvals)
    .innerJoin(orders, eq(orders.id, approvals.orderId))
    .where(declinedWhere)
    .get();
  return row?.n ?? 0;
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
