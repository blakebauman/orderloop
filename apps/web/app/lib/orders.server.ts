import {
  approvals,
  contractPrices,
  customers,
  documents,
  flows,
  inboundEmails,
  messages,
  orders,
  payments,
  priceRules,
  priceSources,
  products,
  shipments,
} from '@orderloop/db';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from './env.server';

export type OrderFilters = {
  type?: string;
  status?: string;
  q?: string;
  /** Newest first by default; "updated" and "total" sort descending too. */
  sort?: 'created' | 'updated' | 'total';
};

export async function listOrders(f: OrderFilters = {}, limit = 200) {
  const where = and(
    f.type ? eq(orders.type, f.type) : undefined,
    f.status ? eq(orders.status, f.status) : undefined,
    f.q
      ? or(
          like(orders.id, `%${f.q}%`),
          like(orders.title, `%${f.q}%`),
          like(orders.customerId, `%${f.q}%`),
        )
      : undefined,
  );
  const order =
    f.sort === 'total' ? orders.total : f.sort === 'updated' ? orders.updatedAt : orders.createdAt;
  return db().select().from(orders).where(where).orderBy(desc(order)).limit(limit);
}

export async function dashboardStats() {
  const byStatus = await db()
    .select({
      status: orders.status,
      n: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${orders.total}), 0)`,
    })
    .from(orders)
    .groupBy(orders.status);
  const byType = await db()
    .select({ type: orders.type, n: sql<number>`count(*)` })
    .from(orders)
    .groupBy(orders.type);
  const pending = await db()
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .get();
  return { byStatus, byType, pendingApprovals: pending?.n ?? 0 };
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
      orderType: orders.type,
      orderTitle: orders.title,
      customerId: orders.customerId,
      customerName: customers.name,
    })
    .from(approvals)
    .leftJoin(orders, eq(orders.id, approvals.orderId))
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(status === 'all' ? undefined : eq(approvals.status, status))
    .orderBy(desc(approvals.requestedAt))
    .limit(200);
}

export async function orderRecords(orderId: string) {
  const [docs, msgs, pays, ships] = await Promise.all([
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
  ]);
  return { documents: docs, messages: msgs, payments: pays, shipments: ships };
}

export async function getOrderRow(orderId: string) {
  return db().select().from(orders).where(eq(orders.id, orderId)).get();
}

export async function backOffice() {
  const [cust, prods, sources, rules, contracts] = await Promise.all([
    db().select().from(customers).orderBy(customers.name),
    db().select().from(products).orderBy(products.sku),
    db().select().from(priceSources).orderBy(priceSources.priority),
    db().select().from(priceRules).orderBy(priceRules.sourceId, priceRules.sku, priceRules.minQty),
    db().select().from(contractPrices).orderBy(contractPrices.customerId, contractPrices.sku),
  ]);
  return { customers: cust, products: prods, pricing: { sources, rules, contracts } };
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
      orderType: flows.orderType,
      version: flows.publishedVersion,
    })
    .from(flows)
    .where(sql`${flows.publishedVersion} is not null`)
    .orderBy(flows.name);
}

/** Customer display names by id, for lists that only carry the id. */
export async function customerNames(): Promise<Record<string, string>> {
  const rows = await db().select({ id: customers.id, name: customers.name }).from(customers);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/**
 * Cancelled orders that were declined by policy (their approval was rejected or escalated) rather
 * than cancelled by a person. The index keeps one status; the approvals table says which.
 */
export async function declinedOrderIds(): Promise<Set<string>> {
  const rows = await db()
    .selectDistinct({ id: approvals.orderId })
    .from(approvals)
    .innerJoin(orders, eq(orders.id, approvals.orderId))
    .where(
      and(inArray(approvals.status, ['escalated', 'rejected']), eq(orders.status, 'cancelled')),
    );
  return new Set(rows.map((r) => r.id));
}

/** The email intake log: every message the engine's email() entrypoint saw, newest first. */
export async function recentInboundEmails(limit = 20) {
  return db().select().from(inboundEmails).orderBy(desc(inboundEmails.receivedAt)).limit(limit);
}
