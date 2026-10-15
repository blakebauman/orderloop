import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Order, OrderInput, OrderState, PaymentEvent } from '@orderloop/core';
import {
  balanceEntries,
  createDb,
  customers,
  invoices,
  paymentEvents,
  payments,
  publishFlow,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueStripeInvoice, settleInvoice, voidInvoices } from '../../src/billing';
import { reverseBalance } from '../../src/connectors';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { handleStripeEvent } from '../../src/payment-events';
import { installStripeFake, type StripeFake } from '../stripe-fake';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;
const invoiceRows = (orderId: string) =>
  db().select().from(invoices).where(eq(invoices.orderId, orderId)).all();
const balanceOf = async (id: string) =>
  (await db().select().from(customers).where(eq(customers.id, id)).get())!.balance;

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string) =>
  until(async () => {
    const s = await state(id);
    return pred(s) ? s : false;
  }, what);
const waitsFor = (id: string, what: string) =>
  waitingOn(id, (s) => s.waits.some((w) => w.event === what || w.kind === what), what);
const settled = (id: string) =>
  waitingOn(
    id,
    (s) => ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'].includes(s.status),
    'a terminal status',
  );

const input = (o: Partial<OrderInput> & Pick<OrderInput, 'model'>): OrderInput => ({
  channel: 'api',
  currency: 'USD',
  lines: [],
  meta: {},
  ...o,
});
const order = (id: string, o: Partial<Order> = {}): Order => ({
  ...input({ model: 'b2b', customerId: 'cus_northwind' }),
  id,
  title: `Order ${id}`,
  createdAt: Date.now(),
  lines: [
    { sku: 'WID-100', name: 'Widget', qty: 3, unitPrice: 21.5 },
    { sku: 'GSK-010', qty: 2, unitPrice: 7.25 },
  ],
  subtotal: 79,
  shipping: 12.5,
  tax: 7.32,
  total: 98.82,
  ...o,
});
const event = (type: string, object: Record<string, unknown>, id?: string): PaymentEvent => ({
  provider: 'stripe',
  id: id ?? `evt_${type}_${crypto.randomUUID()}`,
  type,
  data: { object },
});

let stripe: StripeFake;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

async function introspect(timeouts: string[] = []) {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    for (const name of timeouts) await m.forceEventTimeout({ name });
  });
}

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  label: id,
  config,
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string, sourceHandle: string | null = null) => ({
  id: `${source}.${sourceHandle ?? 'out'}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: null,
});

beforeAll(async () => {
  await ensureTemplates(env);
  // Invoice through Stripe, wait for an approval (so a payment can arrive before its wait), then
  // wait for the payment; no payment fails the order, which rolls the invoice back.
  await publishFlow(db(), {
    id: 'test-stripe-invoice',
    name: 'Stripe invoice',
    description: '',
    model: 'b2b',
    channels: [],
    nodes: [
      node('start', 'trigger.manual'),
      node('price', 'commerce.price'),
      node('invoice', 'commerce.invoice', { provider: 'stripe', terms: 'net_30' }),
      node('approval', 'control.approval', { title: 'Ship it?', timeout: '1 day' }),
      node('paid', 'control.wait_event', { event: 'payment.received', timeout: '30 days' }),
      node('done', 'control.end', { outcome: 'completed' }),
      node('unpaid', 'control.end', { outcome: 'failed', reason: 'Never paid' }),
      node('no', 'control.end', { outcome: 'declined', reason: 'Not approved' }),
    ],
    edges: [
      edge('start', 'price'),
      edge('price', 'invoice'),
      edge('invoice', 'approval'),
      edge('approval', 'paid', 'approved'),
      edge('approval', 'no', 'rejected'),
      edge('approval', 'no', 'escalated'),
      edge('paid', 'done', 'received'),
      edge('paid', 'unpaid', 'timeout'),
    ],
  });
});
beforeEach(async () => {
  stripe = installStripeFake();
  await db().update(customers).set({ stripeCustomerId: null, stripePaymentMethodId: null });
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
  stripe.restore();
});

describe('issuing a Stripe invoice', () => {
  it('creates the draft, attaches each item to it, finalizes and sends, every call keyed', async () => {
    const o = order('ord_inv_order');
    const row = await issueStripeInvoice(env, o, 'invoice#1', {
      terms: 'net_30',
      sendEmail: true,
      onAccount: true,
    });
    expect(stripe.calls.map((c) => `${c.method} ${c.path.replace(/in_fake\d+/, ':id')}`)).toEqual([
      'POST /v1/customers',
      'POST /v1/invoices',
      'POST /v1/invoiceitems',
      'POST /v1/invoiceitems',
      'POST /v1/invoiceitems',
      'POST /v1/invoiceitems',
      'POST /v1/invoices/:id/finalize',
      'POST /v1/invoices/:id/send',
    ]);
    const [, draft, ...rest] = stripe.calls;
    expect(draft!.params).toMatchObject({
      collection_method: 'send_invoice',
      days_until_due: '30',
      auto_advance: 'false',
      pending_invoice_items_behavior: 'exclude',
      currency: 'usd',
      metadata: { order_id: o.id, step: 'invoice#1', invoice_id: row.id },
    });
    const inv = stripe.invoices.get(row.externalId!)!;
    for (const item of rest.slice(0, 4)) expect(item.params.invoice).toBe(inv.id);
    expect(rest.slice(0, 4).map((c) => [c.params.description, c.params.amount])).toEqual([
      ['Widget × 3', '6450'],
      ['GSK-010 × 2', '1450'],
      ['Shipping', '1250'],
      ['Tax', '732'],
    ]);
    expect(stripe.calls.every((c) => c.method !== 'POST' || c.idempotencyKey)).toBe(true);
    expect(draft!.idempotencyKey).toBe(row.id);
    expect(inv).toMatchObject({ status: 'open', total: 9882, sent: 1, auto_advance: false });
    expect(row).toMatchObject({
      status: 'open',
      provider: 'stripe',
      number: inv.number,
      hostedUrl: inv.hosted_invoice_url,
      balanceEntryId: 'bal_ord_inv_order_invoice_1',
    });
    const nw = await db().select().from(customers).where(eq(customers.id, 'cus_northwind')).get();
    expect(nw!.stripeCustomerId).toBe(inv.customer);

    // A retried step makes no second invoice.
    await issueStripeInvoice(env, o, 'invoice#1', {
      terms: 'net_30',
      sendEmail: true,
      onAccount: true,
    });
    expect(stripe.invoices.size).toBe(1);
    expect(stripe.callsTo('POST', '/v1/invoices')).toHaveLength(1);
  });

  it('finishes a step whose finalize was lost, with one invoice and the same items', async () => {
    const o = order('ord_inv_lost');
    stripe.loseNextResponse(/\/finalize$/);
    const opts = { terms: 'due_on_receipt', sendEmail: false, onAccount: false };
    await expect(issueStripeInvoice(env, o, 'invoice#1', opts)).rejects.toThrow(
      'Network connection lost',
    );
    expect((await invoiceRows(o.id))[0]!.status).toBe('draft');
    const row = await issueStripeInvoice(env, o, 'invoice#1', opts);
    expect(row.status).toBe('open');
    expect(stripe.invoices.size).toBe(1);
    const inv = stripe.invoices.get(row.externalId!)!;
    expect(inv.lines).toHaveLength(4);
    expect(inv.total).toBe(9882);
    expect(inv.sent).toBe(0);
    // Due on receipt asks for a due date a day out rather than days_until_due=0.
    const draft = stripe.callsTo('POST', '/v1/invoices')[0]!;
    expect(draft.params.days_until_due).toBeUndefined();
    const due = Number(draft.params.due_date) * 1000;
    expect(due - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(due - Date.now()).toBeLessThan(25 * 3_600_000);
  });

  it('voids an open invoice, leaves a paid one, and reverses only unpaid account charges', async () => {
    const o = order('ord_inv_void');
    const row = await issueStripeInvoice(env, o, 'invoice#1', {
      terms: 'net_15',
      sendEmail: false,
      onAccount: false,
    });
    expect(await voidInvoices(env, o.id)).toEqual({ voided: 1, paid: [] });
    expect(stripe.invoices.get(row.externalId!)!.status).toBe('void');
    expect(await voidInvoices(env, o.id)).toEqual({ voided: 0, paid: [] });

    const p = order('ord_inv_paid');
    const paid = await issueStripeInvoice(env, p, 'invoice#1', {
      terms: 'net_15',
      sendEmail: false,
      onAccount: false,
    });
    // Paid in Stripe, the webhook not yet here: the void finds out and leaves it.
    stripe.payInvoice(paid.externalId!);
    expect(await voidInvoices(env, p.id)).toEqual({ voided: 0, paid: [paid.number] });
    expect(stripe.invoices.get(paid.externalId!)!.status).toBe('paid');
    expect((await invoiceRows(p.id))[0]!.status).toBe('open');
  });
});

describe('Stripe events', () => {
  it('settles a paid invoice, resumes payment.received and ignores the same event again', async () => {
    await introspect();
    const before = await balanceOf('cus_northwind');
    const { orderId } = await startOrder(env, {
      flowId: 'test-stripe-invoice',
      input: input({
        model: 'b2b',
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 2 }],
      }),
    });
    const s = await waitsFor(orderId, 'approval');
    const total = s.order!.total;
    expect(await balanceOf('cus_northwind')).toBeCloseTo(before + total, 6);
    const [row] = await invoiceRows(orderId);
    expect(row).toMatchObject({ status: 'open', amount: total });
    expect(s.nodes.invoice!.output).toMatchObject({
      stripe: { invoiceId: row!.externalId, hostedUrl: row!.hostedUrl },
    });

    // Paid before anything waits for the payment: settled, and Stripe is asked to retry.
    const paid = stripe.payInvoice(row!.externalId!) as PaymentEvent;
    expect(await handleStripeEvent(env, paid)).toMatchObject({ outcome: 'retry', orderId });
    expect(await db().select().from(paymentEvents).where(eq(paymentEvents.id, paid.id))).toEqual(
      [],
    );
    expect((await invoiceRows(orderId))[0]!.status).toBe('paid');
    expect(await balanceOf('cus_northwind')).toBeCloseTo(before, 6);

    await agent(orderId).decide('approval', 'approved', 'sales');
    await waitsFor(orderId, 'payment.received');
    expect(await handleStripeEvent(env, paid)).toEqual({
      outcome: 'handled',
      orderId,
      delivered: 'payment.received',
    });
    expect(await handleStripeEvent(env, paid)).toEqual({ outcome: 'duplicate' });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.vars).toMatchObject({ invoiceUrl: row!.hostedUrl });

    // Settled once: one payment, one settlement, the balance back where it was.
    const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(pays.map((p) => [p.kind, p.status, p.amount, p.externalId])).toEqual([
      ['invoice_payment', 'succeeded', total, row!.externalId],
    ]);
    const ledger = await db()
      .select()
      .from(balanceEntries)
      .where(eq(balanceEntries.orderId, orderId));
    expect(ledger.map((e) => [e.id.split('_')[0], e.amount]).sort()).toEqual([
      ['bal', total],
      ['set', -total],
    ]);
    expect(await balanceOf('cus_northwind')).toBeCloseTo(before, 6);
    expect(await settleInvoice(env, row!.externalId!)).toMatchObject({ settled: false });
    expect(await reverseBalance(env, orderId)).toBe(0);
    expect(await balanceOf('cus_northwind')).toBeCloseTo(before, 6);
  });

  it('ignores invoices and intents OrderLoop did not make', async () => {
    expect(
      await handleStripeEvent(env, event('invoice.paid', { id: 'in_elsewhere', amount_paid: 1 })),
    ).toMatchObject({ outcome: 'ignored' });
    expect(await handleStripeEvent(env, event('customer.created', { id: 'cus_x' }))).toMatchObject({
      outcome: 'ignored',
    });
    expect(
      await handleStripeEvent(
        env,
        event('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_elsewhere' }),
      ),
    ).toMatchObject({ outcome: 'ignored' });
  });

  it('marks a payment voided when Stripe cancels its intent', async () => {
    const { authorizePayment } = await import('../../src/payments');
    const auth = await authorizePayment(
      env,
      order('ord_inv_pi', { total: 40 }),
      'authorize#1',
      'card',
    );
    const r = await handleStripeEvent(
      env,
      event('payment_intent.canceled', { id: auth.intentId, object: 'payment_intent' }),
    );
    expect(r).toEqual({ outcome: 'handled', orderId: 'ord_inv_pi' });
    const [row] = await db().select().from(payments).where(eq(payments.orderId, 'ord_inv_pi'));
    expect(row!.status).toBe('voided');
  });
});

describe('orders with a Stripe invoice', () => {
  it('voids the invoice and reverses the charge when the order fails', async () => {
    await introspect(['paid#1']);
    const before = await balanceOf('cus_northwind');
    const { orderId } = await startOrder(env, {
      flowId: 'test-stripe-invoice',
      input: input({
        model: 'b2b',
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 1 }],
      }),
    });
    await waitsFor(orderId, 'approval');
    await agent(orderId).decide('approval', 'approved', 'sales');
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    const voided = await until(async () => {
      const [row] = await invoiceRows(orderId);
      return row?.status === 'void' && row;
    }, 'the void');
    expect(stripe.invoices.get(voided.externalId!)!.status).toBe('void');
    await until(
      async () => Math.abs((await balanceOf('cus_northwind')) - before) < 1e-6,
      'the reversed charge',
    );
  });

  it('leaves a paid invoice alone when the order is cancelled, keeping the settlement', async () => {
    await introspect();
    const before = await balanceOf('cus_northwind');
    const { orderId } = await startOrder(env, {
      flowId: 'test-stripe-invoice',
      input: input({
        model: 'b2b',
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 1 }],
      }),
    });
    await waitsFor(orderId, 'approval');
    const [row] = await invoiceRows(orderId);
    expect(
      await handleStripeEvent(env, stripe.payInvoice(row!.externalId!) as PaymentEvent),
    ).toMatchObject({ outcome: 'retry' });
    await agent(orderId).cancel('Changed our mind');
    const s = await state(orderId);
    expect(s.status).toBe('cancelled');
    expect(s.timeline.at(-1)!.message).toMatch(/left paid invoices/);
    expect(stripe.invoices.get(row!.externalId!)!.status).toBe('paid');
    expect((await invoiceRows(orderId))[0]!.status).toBe('paid');
    expect(await balanceOf('cus_northwind')).toBeCloseTo(before, 6);
  });

  it('voids an unpaid invoice when the order is cancelled', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-stripe-invoice',
      input: input({
        model: 'b2b',
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 1 }],
      }),
    });
    await waitsFor(orderId, 'approval');
    await agent(orderId).cancel('Changed our mind');
    const [row] = await invoiceRows(orderId);
    expect(row!.status).toBe('void');
    expect(stripe.invoices.get(row!.externalId!)!.status).toBe('void');
    expect((await state(orderId)).timeline.at(-1)!.message).toMatch(/voided 1 invoices/);
  });
});
