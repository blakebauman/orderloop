/**
 * Mock commerce connectors over the D1 back office and R2. Each is the seam where a real adapter
 * (Stripe, a WMS, a carrier API, NetSuite) plugs in later. Every write is keyed by the step that
 * made it, so a retried step never double-books, and every compensation is idempotent.
 *
 * Failure simulation for demos and tests: set `order.meta.simulate` to one of
 * "payment_decline", "charge_fail", "out_of_stock", "three_way_mismatch".
 */

import { money, newId, type Order, type StockLine } from '@orderloop/core';
import {
  contractPrices,
  createDb,
  customers,
  documents,
  messages,
  payments,
  products,
  reservations,
  shipments,
  stockMovements,
} from '@orderloop/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

const db = (env: Env) => createDb(env.DB);
const simulate = (order: Order) => String(order.meta?.simulate ?? '');

export async function getCustomer(env: Env, id: string | undefined) {
  if (!id) return undefined;
  return db(env).query.customers.findFirst({ where: eq(customers.id, id) });
}

export async function findCustomerByName(env: Env, name: string) {
  const all = await db(env).select().from(customers);
  const needle = name.toLowerCase();
  return all.find(
    (c) => c.name.toLowerCase().includes(needle) || needle.includes(c.name.toLowerCase()),
  );
}

export async function getProducts(env: Env, skus?: string[]) {
  const q = db(env).select().from(products);
  return skus ? q.where(inArray(products.sku, skus)) : q;
}

export async function contractPricesFor(env: Env, customerId: string) {
  const rows = await db(env)
    .select()
    .from(contractPrices)
    .where(eq(contractPrices.customerId, customerId));
  return new Map(rows.map((r) => [r.sku, r.price]));
}

// ── Inventory ──────────────────────────────────────────────────────────────

export async function reserveInventory(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const idFor = (i: number, sku: string) =>
    `res_${order.id}_${stepKey}_${i}_${sku}`.replace(/[^\w-]/g, '_');
  const prefix = idFor(0, '').slice(0, -2);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, order.id), eq(reservations.status, 'held')));
  // Stock held by an earlier step (another loop run): the order already has it.
  const earlier = held.filter((r) => !r.id.startsWith(prefix));
  if (earlier.length) return { reservationIds: earlier.map((r) => r.id), short: [] as string[] };
  // Lines this step already held before it was retried count as available.
  const mine = new Set(held.map((r) => r.id));

  const stock = new Map(
    (
      await getProducts(
        env,
        order.lines.map((l) => l.sku),
      )
    ).map((p) => [p.sku, p]),
  );
  const short = order.lines
    .filter((l, i) => {
      if (mine.has(idFor(i, l.sku))) return false;
      const p = stock.get(l.sku);
      return simulate(order) === 'out_of_stock' || !p || p.stock - p.reserved < l.qty;
    })
    .map((l) => l.sku);

  const reservationIds: string[] = [];
  for (const [i, line] of order.lines.entries()) {
    if (short.includes(line.sku)) continue;
    // Keyed by order, step and line, so neither another order nor a repeated SKU collides.
    const id = idFor(i, line.sku);
    await moveStock(
      env,
      { id, orderId: order.id, sku: line.sku, kind: 'hold', qty: line.qty },
      d
        .insert(reservations)
        .values({
          id,
          orderId: order.id,
          sku: line.sku,
          qty: line.qty,
          status: 'held',
          createdAt: Date.now(),
        })
        .onConflictDoNothing(),
    );
    reservationIds.push(id);
  }
  return { reservationIds, short };
}

/** Compensation: release every held reservation for the order. Idempotent. */
export async function releaseInventory(env: Env, orderId: string) {
  const d = db(env);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'held')));
  for (const r of held) {
    await d.update(reservations).set({ status: 'released' }).where(eq(reservations.id, r.id));
    await d
      .update(products)
      .set({ reserved: sql`max(0, ${products.reserved} - ${r.qty})` })
      .where(eq(products.sku, r.sku));
  }
  return held.length;
}

/** Shipping consumes held stock. */
export async function consumeInventory(env: Env, orderId: string) {
  const d = db(env);
  const held = await d
    .select()
    .from(reservations)
    .where(and(eq(reservations.orderId, orderId), eq(reservations.status, 'held')));
  for (const r of held) {
    await d.update(reservations).set({ status: 'consumed' }).where(eq(reservations.id, r.id));
    await d
      .update(products)
      .set({
        stock: sql`${products.stock} - ${r.qty}`,
        reserved: sql`max(0, ${products.reserved} - ${r.qty})`,
      })
      .where(eq(products.sku, r.sku));
  }
}

/** Adds returned or received stock, once per step and line. */
export async function restock(env: Env, orderId: string, stepKey: string, lines: StockLine[]) {
  for (const [i, l] of lines.entries()) {
    const id = `stk_${orderId}_${stepKey}_${i}_${l.sku}`.replace(/[^\w-]/g, '_');
    await moveStock(env, { id, orderId, sku: l.sku, kind: 'restock', qty: l.qty });
  }
}

/**
 * Records one inventory change in the ledger and applies it in the same batch, only if it hasn't
 * been applied yet. D1 runs a batch as one transaction, so a crash can't leave the ledger and the
 * product row disagreeing, and a retry with the same id changes nothing. `first` runs at the
 * start of the batch (the reservation row for a hold).
 */
async function moveStock(
  env: Env,
  m: { id: string; orderId: string; sku: string; kind: 'hold' | 'restock'; qty: number },
  first?: BatchItem<'sqlite'>,
) {
  const d = db(env);
  const pending = and(eq(stockMovements.id, m.id), eq(stockMovements.applied, false));
  const change =
    m.kind === 'hold'
      ? { reserved: sql`${products.reserved} + ${m.qty}` }
      : { stock: sql`${products.stock} + ${m.qty}` };
  const record = d
    .insert(stockMovements)
    .values({ ...m, createdAt: Date.now() })
    .onConflictDoNothing();
  const apply = d
    .update(products)
    .set(change)
    .where(
      and(eq(products.sku, m.sku), sql`exists (select 1 from ${stockMovements} where ${pending})`),
    );
  const mark = d.update(stockMovements).set({ applied: true }).where(eq(stockMovements.id, m.id));
  await (first ? d.batch([first, record, apply, mark]) : d.batch([record, apply, mark]));
}

export async function lowStock(env: Env) {
  const all = await getProducts(env);
  return all.filter((p) => p.stock - p.reserved <= p.reorderPoint);
}

// ── Payments ───────────────────────────────────────────────────────────────

async function recordPayment(
  env: Env,
  id: string,
  orderId: string,
  kind: string,
  amount: number,
  status: string,
  ref?: string,
) {
  await db(env)
    .insert(payments)
    .values({ id, orderId, kind, amount, status, ref, createdAt: Date.now() })
    .onConflictDoNothing();
  return { paymentId: id, amount, status };
}

export async function authorizePayment(env: Env, order: Order, stepKey: string, method: string) {
  const declined = simulate(order) === 'payment_decline';
  return recordPayment(
    env,
    `pay_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_'),
    order.id,
    `authorization:${method}`,
    order.total,
    declined ? 'declined' : 'authorized',
  );
}

/** Compensation: void every open authorization for the order. Idempotent. */
export async function voidAuthorizations(env: Env, orderId: string) {
  const res = await db(env)
    .update(payments)
    .set({ status: 'voided' })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'authorized')))
    .returning();
  return res.length;
}

export async function capturePayment(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const [auth] = await d
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.status, 'authorized')));
  if (!auth) return { paymentId: null, amount: 0, status: 'failed' };
  await d.update(payments).set({ status: 'captured' }).where(eq(payments.id, auth.id));
  return recordPayment(
    env,
    `cap_${stepKey}_${order.id}`.replace(/[^\w-]/g, '_'),
    order.id,
    'capture',
    auth.amount,
    'succeeded',
    auth.id,
  );
}

export async function charge(env: Env, order: Order, stepKey: string) {
  const fail = simulate(order) === 'charge_fail';
  return recordPayment(
    env,
    `chg_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_'),
    order.id,
    'charge',
    order.total,
    fail ? 'failed' : 'succeeded',
  );
}

/**
 * Refunds up to `requested` (everything still refundable when omitted) of the money captured or
 * charged on the order. Keyed by step: a retried step returns the refund it already made.
 */
export async function refund(env: Env, order: Order, stepKey: string, requested?: number) {
  const d = db(env);
  const id = `rfd_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const done = await d.select().from(payments).where(eq(payments.id, id)).get();
  if (done) return { paymentId: id, amount: done.amount, status: done.status };

  const rows = await d.select().from(payments).where(eq(payments.orderId, order.id));
  const paid = rows
    .filter((p) => p.status === 'succeeded' && (p.kind === 'capture' || p.kind === 'charge'))
    .reduce((s, p) => s + p.amount, 0);
  const refunded = rows
    .filter((p) => p.kind === 'refund' && p.status === 'succeeded')
    .reduce((s, p) => s + p.amount, 0);
  const refundable = money(paid - refunded);
  const amount = money(Math.min(requested ?? refundable, refundable));
  if (amount <= 0) return { paymentId: null, amount: 0, status: 'failed' };
  return recordPayment(env, id, order.id, 'refund', amount, 'succeeded');
}

export async function addToBalance(env: Env, customerId: string | undefined, amount: number) {
  if (!customerId) return;
  await db(env)
    .update(customers)
    .set({ balance: sql`${customers.balance} + ${amount}` })
    .where(eq(customers.id, customerId));
}

// ── Shipping ───────────────────────────────────────────────────────────────

export async function createShipment(env: Env, order: Order, stepKey: string, carrier: string) {
  const id = `shp_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const tracking = `${carrier.toUpperCase()}${Math.abs(hash(id)).toString().padStart(10, '0').slice(0, 10)}`;
  await db(env)
    .insert(shipments)
    .values({
      id,
      orderId: order.id,
      carrier,
      tracking,
      status: 'label_created',
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  await consumeInventory(env, order.id);
  return { shipmentId: id, carrier, tracking };
}

/** A prepaid return label. Stock comes back with `restock` once the goods arrive. */
export async function createReturnLabel(env: Env, order: Order, stepKey: string, carrier: string) {
  const id = `rma_${order.id}_${stepKey}`.replace(/[^\w-]/g, '_');
  const tracking = `${carrier.toUpperCase()}R${Math.abs(hash(id)).toString().padStart(9, '0').slice(0, 9)}`;
  await db(env)
    .insert(shipments)
    .values({
      id,
      orderId: order.id,
      carrier,
      tracking,
      status: 'return_label',
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  return { rmaId: id, carrier, tracking };
}

/** Compensation: cancel a shipment that was booked by this step. */
export async function cancelShipment(env: Env, shipmentId: string) {
  await db(env).update(shipments).set({ status: 'cancelled' }).where(eq(shipments.id, shipmentId));
}

export async function cancelOpenShipments(env: Env, orderId: string) {
  const res = await db(env)
    .update(shipments)
    .set({ status: 'cancelled' })
    .where(and(eq(shipments.orderId, orderId), eq(shipments.status, 'label_created')))
    .returning();
  return res.length;
}

// ── Documents (R2) and outbox ────────────────────────────────────────────────

export async function storeDocument(
  env: Env,
  orderId: string,
  kind: string,
  name: string,
  body: string,
  contentType = 'text/html; charset=utf-8',
) {
  const key = `orders/${orderId}/${kind}/${name}`;
  await env.DOCS.put(key, body, { httpMetadata: { contentType } });
  await db(env)
    .insert(documents)
    .values({ id: key, orderId, kind, r2Key: key, contentType, createdAt: Date.now() })
    .onConflictDoNothing();
  return key;
}

export async function sendMessage(
  env: Env,
  orderId: string,
  stepKey: string,
  recipient: string,
  subject: string,
  body: string,
) {
  const id = `msg_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');
  await db(env)
    .insert(messages)
    .values({ id, orderId, recipient, subject, body, createdAt: Date.now() })
    .onConflictDoNothing();
  return { messageId: id, recipient, subject };
}

export function renderDocument(title: string, order: Order, extra: Record<string, string> = {}) {
  const rows = order.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.sku)}</td><td>${esc(l.name ?? '')}</td><td>${l.qty}</td><td>${(l.unitPrice ?? 0).toFixed(2)}</td><td>${money(l.qty * (l.unitPrice ?? 0)).toFixed(2)}</td></tr>`,
    )
    .join('');
  const meta = Object.entries(extra)
    .map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v)}</p>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px system-ui;margin:40px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}</style>
<h1>${esc(title)}</h1><p>Order ${esc(order.id)} · ${new Date().toISOString().slice(0, 10)}</p>${meta}
<table><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit</th><th>Line</th></tr>${rows}</table>
<p>Subtotal ${order.subtotal.toFixed(2)} · Tax ${order.tax.toFixed(2)} · <b>Total ${order.total.toFixed(2)} ${esc(order.currency)}</b></p>`;
}

/** Undo everything compensable for an order (cancel path; Workflow rollback covers failures). */
export async function compensateOrder(env: Env, orderId: string) {
  const [released, voided, cancelled] = await Promise.all([
    releaseInventory(env, orderId),
    voidAuthorizations(env, orderId),
    cancelOpenShipments(env, orderId),
  ]);
  return { released, voided, cancelled };
}

export const idFor = newId;

function esc(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
