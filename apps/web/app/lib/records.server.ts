import {
  contains,
  customers,
  documents,
  invoices,
  locations,
  messages,
  orders,
  payments,
  payouts,
  reservations,
  sellerOrders,
  sellers,
  shipments,
} from '@orderloop/db';
import { desc, eq, or, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from './env.server';
import { humanize, money } from './format';
import { type RecordKind, type RecordRow, stepOf } from './records';

/** Rows per kind of record. */
const PER_KIND = 30;

/**
 * The latest records orders wrote, by kind, newest first: payments, invoices and payouts; shipments;
 * stock holds; seller orders; messages; documents. With `q`, only those whose order (id, `#ref`,
 * title, customer, contact email) or own fields (SKU, recipient, tracking number, seller) match.
 */
export async function recentRecords(q?: string): Promise<Record<RecordKind, RecordRow[]>> {
  const term = q?.trim().replace(/^#/, '') || '';
  const match = (...own: SQLWrapper[]): SQL | undefined =>
    term
      ? or(
          contains(orders.id, term),
          contains(orders.title, term),
          contains(orders.contactEmail, term),
          contains(customers.name, term),
          ...own.map((c) => contains(c, term)),
        )
      : undefined;
  const order = {
    orderId: orders.id,
    orderTitle: orders.title,
    customerName: customers.name,
    contactEmail: orders.contactEmail,
  };
  const base = <
    T extends {
      orderId: string | null;
      orderTitle: string | null;
      customerName: string | null;
      contactEmail: string | null;
    },
  >(
    r: T,
  ) => ({
    orderId: r.orderId ?? '',
    orderTitle: r.orderTitle || '',
    customer: r.customerName ?? r.contactEmail ?? null,
  });

  const [pays, bills, outs, ships, holds, parts, msgs, docs] = await Promise.all([
    db()
      .select({ ...order, row: payments })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(match(payments.ref, payments.externalId))
      .orderBy(desc(payments.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: invoices })
      .from(invoices)
      .innerJoin(orders, eq(orders.id, invoices.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(match(invoices.number))
      .orderBy(desc(invoices.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: payouts, seller: sellers.name })
      .from(payouts)
      .innerJoin(orders, eq(orders.id, payouts.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(sellers, eq(sellers.id, payouts.sellerId))
      .where(match(sellers.name))
      .orderBy(desc(payouts.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: shipments })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(match(shipments.tracking, shipments.carrier))
      .orderBy(desc(shipments.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: reservations, location: locations.name })
      .from(reservations)
      .innerJoin(orders, eq(orders.id, reservations.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(locations, eq(locations.id, reservations.locationId))
      .where(match(reservations.sku))
      .orderBy(desc(reservations.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: sellerOrders, seller: sellers.name })
      .from(sellerOrders)
      .innerJoin(orders, eq(orders.id, sellerOrders.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
      .where(match(sellers.name))
      .orderBy(desc(sellerOrders.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: messages })
      .from(messages)
      .innerJoin(orders, eq(orders.id, messages.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(match(messages.recipient, messages.subject))
      .orderBy(desc(messages.createdAt))
      .limit(PER_KIND),
    db()
      .select({ ...order, row: documents })
      .from(documents)
      .innerJoin(orders, eq(orders.id, documents.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(match(documents.kind))
      .orderBy(desc(documents.createdAt))
      .limit(PER_KIND),
  ]);

  const cash: RecordRow[] = [
    ...pays.map((p) => ({
      ...base(p),
      id: p.row.id,
      kind: 'money' as const,
      // "authorization:card_present" is an authorization, by card present.
      what: humanize(p.row.kind.split(':')[0]),
      detail:
        [
          p.row.kind.includes(':') ? humanize(p.row.kind.split(':')[1]) : null,
          p.row.provider === 'stripe' ? 'Stripe' : null,
          // A ref that is another row's id (a capture's authorization) says nothing here.
          p.row.ref && !p.row.ref.includes(p.row.orderId) ? p.row.ref : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      amount: p.row.amount,
      currency: p.row.currency,
      status: p.row.status,
      step: stepOf(p.row.id, p.row.orderId),
      at: p.row.createdAt,
    })),
    ...bills.map((b) => ({
      ...base(b),
      id: b.row.id,
      kind: 'money' as const,
      what: `Invoice${b.row.number ? ` ${b.row.number}` : ''}`,
      detail:
        [b.row.provider === 'stripe' ? 'Stripe' : null, b.row.terms ? humanize(b.row.terms) : null]
          .filter(Boolean)
          .join(' · ') || null,
      amount: b.row.amount,
      currency: b.row.currency,
      status: b.row.status,
      step: stepOf(b.row.id, b.row.orderId),
      at: b.row.createdAt,
    })),
    ...outs.map((p) => ({
      ...base(p),
      id: p.row.id,
      kind: 'money' as const,
      what: `Payout to ${p.seller ?? p.row.sellerId}`,
      detail: `${money(p.row.gross)} gross, ${money(p.row.commission)} commission`,
      amount: p.row.net,
      currency: null,
      status: p.row.status,
      step: stepOf(p.row.id, p.row.orderId),
      at: p.row.createdAt,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, PER_KIND);

  return {
    money: cash,
    shipments: ships.map((s) => ({
      ...base(s),
      id: s.row.id,
      kind: 'shipments' as const,
      what: [s.row.carrier, s.row.tracking].filter(Boolean).join(' ') || 'Shipment',
      detail: null,
      amount: null,
      currency: null,
      status: s.row.status,
      step: stepOf(s.row.id, s.row.orderId),
      at: s.row.createdAt,
    })),
    holds: holds.map((h) => ({
      ...base(h),
      id: h.row.id,
      kind: 'holds' as const,
      what: `${h.row.qty} × ${h.row.sku}`,
      detail: h.location ? `at ${h.location}` : 'at the warehouse',
      amount: null,
      currency: null,
      status: h.row.status,
      step: stepOf(h.row.id, h.row.orderId),
      at: h.row.createdAt,
    })),
    sellers: parts.map((p) => ({
      ...base(p),
      id: p.row.id,
      kind: 'sellers' as const,
      what: p.seller ?? p.row.sellerId,
      detail: p.row.reason,
      amount: p.row.subtotal,
      currency: null,
      status: p.row.status,
      step: null,
      at: p.row.createdAt,
    })),
    messages: msgs.map((m) => ({
      ...base(m),
      id: m.row.id,
      kind: 'messages' as const,
      what: m.row.subject,
      detail: `To ${m.row.recipient}`,
      amount: null,
      currency: null,
      status: null,
      step: null,
      at: m.row.createdAt,
    })),
    documents: docs.map((d) => ({
      ...base(d),
      id: d.row.id,
      kind: 'documents' as const,
      what: humanize(d.row.kind),
      detail: d.row.contentType,
      amount: null,
      currency: null,
      status: null,
      step: null,
      at: d.row.createdAt,
    })),
  };
}
