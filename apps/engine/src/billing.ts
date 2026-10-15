/**
 * Invoices issued through Stripe: `commerce.invoice` with provider "stripe" (the R2 document is
 * rendered either way). The customer pays on Stripe's hosted invoice page; Stripe's `invoice.paid`
 * event (./payment-events) settles the invoice here and resumes the order.
 *
 * The `invoices` row is written before Stripe is called and carries the due date the request asks
 * for, so a retried step sends byte-for-byte the same requests under the same idempotency keys
 * (all derived from the row id, which is derived from the step's effect key) and Stripe replays
 * its first answers. In PAYMENTS_MODE "mock" the row is recorded as a mock invoice and nothing is
 * sent.
 *
 * Order matters: since API 2022-08-01 a new invoice no longer sweeps up pending invoice items, so
 * the draft is created first (`pending_invoice_items_behavior=exclude`) and each item is attached to
 * it by id, then it is finalized and, if asked, sent.
 */

import { type Order, toMinor } from '@orderloop/core';
import { balanceEntries, createDb, customers, invoices, payments } from '@orderloop/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ensureCustomer, rethrow, rowId, type Stripe, stripeFor, stripeMode } from './gateway';
import { type Invoice, StripeError } from './stripe';

const DAY = 86_400_000;
const db = (env: Env) => createDb(env.DB);

export type InvoiceTerms = 'due_on_receipt' | 'net_15' | 'net_30' | 'net_60';
export const TERM_DAYS: Record<string, number> = {
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_60: 60,
};

export type InvoiceRow = typeof invoices.$inferSelect;

/** The `balance_entries` id `addToBalance` gives an order's charge for one step. */
export const balanceEntryId = (orderId: string, stepKey: string) => rowId('bal', orderId, stepKey);

/**
 * When the invoice is due. Net terms use Stripe's `days_until_due`. "Due on receipt" asks for a
 * `due_date` one day out: Stripe documents `days_until_due` only as a number of days, so rather
 * than rely on 0 being accepted, the invoice is due the next day.
 */
function dueParams(terms: string, row: InvoiceRow) {
  const days = TERM_DAYS[terms] ?? 30;
  return days > 0
    ? { days_until_due: days }
    : { due_date: Math.floor((row.dueAt ?? row.createdAt + DAY) / 1000) };
}

/** The invoice's items in minor units: each line, shipping, tax, and whatever rounding is left. */
function invoiceItems(order: Order) {
  const items: { description: string; amount: number }[] = [];
  for (const l of order.lines) {
    const amount = toMinor(l.qty * (l.unitPrice ?? 0), order.currency);
    if (amount) items.push({ description: `${l.name ?? l.sku} × ${l.qty}`, amount });
  }
  const shipping = toMinor(order.shipping ?? 0, order.currency);
  if (shipping)
    items.push({
      description: order.shippingOption ? `Shipping (${order.shippingOption})` : 'Shipping',
      amount: shipping,
    });
  const tax = toMinor(order.tax, order.currency);
  if (tax) items.push({ description: 'Tax', amount: tax });
  const rest = toMinor(order.total, order.currency) - items.reduce((s, i) => s + i.amount, 0);
  if (rest) items.push({ description: 'Adjustments', amount: rest });
  return items;
}

async function findInvoice(env: Env, id: string) {
  return db(env).select().from(invoices).where(eq(invoices.id, id)).get();
}

/**
 * Issues the order's invoice through Stripe once per step: the Stripe customer (the account's, or
 * one created under `cust_<id>`), a draft invoice, its items, finalization and, with `sendEmail`,
 * Stripe's email. Returns the invoice row as it stands.
 */
export async function issueStripeInvoice(
  env: Env,
  order: Order,
  stepKey: string,
  opts: { terms: string; sendEmail: boolean; onAccount: boolean },
): Promise<InvoiceRow> {
  const d = db(env);
  const id = rowId('inv', order.id, stepKey);
  const live = stripeMode(env);
  const now = Date.now();
  const days = TERM_DAYS[opts.terms] ?? 30;
  await d
    .insert(invoices)
    .values({
      id,
      orderId: order.id,
      provider: live ? 'stripe' : 'mock',
      status: live ? 'pending' : 'open',
      amount: order.total,
      currency: order.currency,
      terms: opts.terms,
      dueAt: now + Math.max(days, 1) * DAY,
      balanceEntryId: opts.onAccount ? balanceEntryId(order.id, stepKey) : null,
      createdAt: now,
    })
    .onConflictDoNothing();
  let row = (await findInvoice(env, id))!;
  if (row.provider !== 'stripe' || row.status === 'void') return row;

  const stripe = stripeFor(env);
  if (row.status === 'pending' || row.status === 'draft') {
    const customer = await ensureCustomer(env, stripe, order);
    let externalId = row.externalId;
    if (!externalId) {
      const draft = await stripe.invoices
        .create(
          {
            customer,
            collection_method: 'send_invoice',
            ...dueParams(opts.terms, row),
            auto_advance: false,
            pending_invoice_items_behavior: 'exclude',
            currency: order.currency.toLowerCase(),
            description: order.title || `Order ${order.id}`,
            metadata: { order_id: order.id, step: stepKey, invoice_id: id },
          },
          id,
        )
        .catch(rethrow);
      externalId = draft.id;
      await d
        .update(invoices)
        .set({ status: 'draft', externalId })
        .where(and(eq(invoices.id, id), eq(invoices.status, 'pending')));
    }
    for (const [i, item] of invoiceItems(order).entries())
      await stripe.invoiceItems
        .create(
          {
            customer,
            invoice: externalId,
            currency: order.currency.toLowerCase(),
            amount: item.amount,
            description: item.description,
            metadata: { order_id: order.id, invoice_id: id },
          },
          `${id}_item_${i}`,
        )
        .catch(rethrow);
    const open = await stripe.invoices
      .finalize(externalId, { auto_advance: false }, `${id}_finalize`)
      .catch(rethrow);
    // Only from pending or draft: an `invoice.paid` that already settled it stays paid.
    await d
      .update(invoices)
      .set({
        status: 'open',
        externalId,
        number: open.number,
        hostedUrl: open.hosted_invoice_url,
        dueAt: open.due_date ? open.due_date * 1000 : row.dueAt,
      })
      .where(and(eq(invoices.id, id), inArray(invoices.status, ['pending', 'draft'])));
    row = (await findInvoice(env, id))!;
  }
  if (opts.sendEmail && row.status === 'open' && row.externalId)
    await stripe.invoices.send(row.externalId, `${id}_send`).catch(rethrow);
  return row;
}

// ── Void ──────────────────────────────────────────────────────────────────

/** Where Stripe has an invoice now, after a request about it was refused. */
async function stripeStatus(stripe: Stripe, externalId: string) {
  return (await stripe.invoices.retrieve(externalId).catch(rethrow)).status;
}

/**
 * Compensation: voids the order's unpaid invoices. A finalized invoice is voided in Stripe, a draft
 * deleted, and D1 changes only after Stripe has. A paid invoice is left alone (the money arrived;
 * refund it if it must go back) and reported in `paid`. An invoice Stripe never confirmed creating
 * (`pending`) is voided here only: an orphaned draft is never finalized or sent.
 */
export async function voidInvoices(env: Env, orderId: string) {
  const d = db(env);
  const rows = await d.select().from(invoices).where(eq(invoices.orderId, orderId));
  const paid = rows.filter((r) => r.status === 'paid').map((r) => r.number ?? r.id);
  let voided = 0;
  for (const row of rows) {
    if (!['pending', 'draft', 'open'].includes(row.status)) continue;
    if (row.provider === 'stripe' && row.externalId) {
      const stripe = stripeFor(env);
      let status: Invoice['status'] | 'deleted' = row.status === 'open' ? 'open' : 'draft';
      for (let attempt = 0; attempt < 2 && status !== 'void' && status !== 'deleted'; attempt++) {
        try {
          if (status === 'draft') {
            await stripe.invoices.del(row.externalId);
            status = 'deleted';
          } else if (status === 'open' || status === 'uncollectible') {
            await stripe.invoices.void(row.externalId, rowId('void', row.id));
            status = 'void';
          } else break;
        } catch (err) {
          if (!(err instanceof StripeError) || err.isRetryable) rethrow(err);
          if (err.code === 'resource_missing') status = 'deleted';
          else status = await stripeStatus(stripe, row.externalId);
        }
      }
      if (status === 'paid') {
        paid.push(row.number ?? row.id);
        continue;
      }
      if (status !== 'void' && status !== 'deleted') continue;
    }
    const res = await d
      .update(invoices)
      .set({ status: 'void' })
      .where(and(eq(invoices.id, row.id), eq(invoices.status, row.status)))
      .returning();
    voided += res.length;
  }
  return { voided, paid };
}

// ── Settle ────────────────────────────────────────────────────────────────

/**
 * Stripe says the invoice is paid: in one D1 batch, the invoice is marked paid, an
 * `invoice_payment` is recorded, and the account charge it made comes off the customer's balance
 * (unless a rollback already reversed it). Idempotent: a repeat changes nothing. Returns null for
 * an invoice OrderLoop didn't issue.
 */
export async function settleInvoice(env: Env, externalId: string, amountPaid?: number) {
  const d = db(env);
  const row = await d.select().from(invoices).where(eq(invoices.externalId, externalId)).get();
  if (!row) return null;
  const now = Date.now();
  const paymentId = rowId('ipay', row.id);
  const amount = amountPaid ?? row.amount;
  const entry = row.balanceEntryId
    ? await d.select().from(balanceEntries).where(eq(balanceEntries.id, row.balanceEntryId)).get()
    : undefined;
  const [marked] = await d.batch([
    d
      .update(invoices)
      .set({ status: 'paid', paidAt: now })
      .where(and(eq(invoices.id, row.id), inArray(invoices.status, ['pending', 'draft', 'open'])))
      .returning(),
    d
      .insert(payments)
      .select(
        d
          .select({
            id: sql`${paymentId}`.as('id'),
            orderId: sql`${row.orderId}`.as('order_id'),
            kind: sql`'invoice_payment'`.as('kind'),
            amount: sql`${amount}`.as('amount'),
            status: sql`'succeeded'`.as('status'),
            ref: sql`${row.id}`.as('ref'),
            createdAt: sql`${now}`.as('created_at'),
            provider: sql`${row.provider}`.as('provider'),
            externalId: sql`${externalId}`.as('external_id'),
            currency: sql`${row.currency}`.as('currency'),
          })
          .from(invoices)
          .where(and(eq(invoices.id, row.id), eq(invoices.status, 'paid'))),
      )
      .onConflictDoNothing(),
    ...(entry ? settleBalance(env, entry, now) : []),
  ]);
  return { invoiceId: row.id, orderId: row.orderId, settled: marked.length > 0, row };
}

const settleId = (entryId: string) => `set_${entryId}`;
const reverseId = (entryId: string) => `rev_${entryId}`;

/** True while the entry has been neither settled nor reversed: either takes it off the balance. */
const unsettled = (entryId: string) =>
  sql`not exists (select 1 from ${balanceEntries} other where other.id in (${settleId(entryId)}, ${reverseId(entryId)}) and other.applied = 1)`;

/**
 * Takes an invoiced account charge back off the balance once: by its `set_` row when the invoice is
 * paid, or its `rev_` row when the order is rolled back, whichever comes first. Each is a batch of
 * three statements (insert the row if the charge is still open, move the balance if the row is
 * pending, mark it applied), like `addToBalance`.
 */
function offsetBalance(
  env: Env,
  entry: typeof balanceEntries.$inferSelect,
  id: string,
  now: number,
) {
  const d = db(env);
  const pending = and(eq(balanceEntries.id, id), eq(balanceEntries.applied, false));
  return [
    d
      .insert(balanceEntries)
      .select(
        d
          .select({
            id: sql`${id}`.as('id'),
            orderId: balanceEntries.orderId,
            customerId: balanceEntries.customerId,
            amount: sql`-${balanceEntries.amount}`.as('amount'),
            applied: sql`0`.as('applied'),
            createdAt: sql`${now}`.as('created_at'),
          })
          .from(balanceEntries)
          .where(
            and(
              eq(balanceEntries.id, entry.id),
              eq(balanceEntries.applied, true),
              unsettled(entry.id),
            ),
          ),
      )
      .onConflictDoNothing(),
    d
      .update(customers)
      .set({ balance: sql`${customers.balance} - ${entry.amount}` })
      .where(
        and(
          eq(customers.id, entry.customerId),
          sql`exists (select 1 from ${balanceEntries} where ${pending})`,
        ),
      ),
    d.update(balanceEntries).set({ applied: true }).where(pending).returning(),
  ] as const;
}

const settleBalance = (env: Env, entry: typeof balanceEntries.$inferSelect, now: number) =>
  offsetBalance(env, entry, settleId(entry.id), now);

/** `reverseBalance`'s statements for one entry (./connectors). */
export const reverseBalanceEntry = (
  env: Env,
  entry: typeof balanceEntries.$inferSelect,
  now: number,
) => offsetBalance(env, entry, reverseId(entry.id), now);
