/**
 * The payment gateway: authorize, capture, charge, void and refund, recorded in D1's `payments`.
 *
 * `PAYMENTS_MODE` picks the processor for new payments. "mock" (the default) only records rows, and
 * `order.meta.simulate` ("payment_decline", "charge_fail") drives failures. "stripe" calls Stripe
 * with `STRIPE_SECRET_KEY`; without a key every payment step fails for good rather than letting an
 * order ship unpaid. Voids, captures and refunds follow the row's own `provider`, so rows made
 * before a mode change are still settled where they were made.
 *
 * Every Stripe write carries an `Idempotency-Key` derived from the payment row id, which is derived
 * from the step's effect key: a retried step replays Stripe's first answer and never pays twice.
 * D1 is written only after Stripe answers.
 */

import {
  money,
  type Order,
  type PaymentSource,
  paymentSource,
  type SavedPayment,
  toMinor,
} from '@orderloop/core';
import { createDb, customers, payments } from '@orderloop/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ensureCustomer, rethrow, rowId, type Stripe, stripeFor, stripeMode } from './gateway';
import { type PaymentIntent, StripeError } from './stripe';

const db = (env: Env) => createDb(env.DB);
const simulate = (order: Order) => String(order.meta?.simulate ?? '');

export type PaymentPurpose = 'hold' | 'verify';

export type PaymentResult = {
  paymentId: string | null;
  amount: number;
  status: string;
  /** Stripe mode only: the PaymentIntent, and why it was declined. */
  intentId?: string;
  reason?: string;
};

type Provider = 'mock' | 'stripe' | 'external' | 'offline';

type PaymentRow = typeof payments.$inferSelect;

const resultOf = (row: PaymentRow): PaymentResult => ({
  paymentId: row.id,
  amount: row.amount,
  status: row.status,
  ...(row.provider === 'stripe' && row.externalId ? { intentId: row.externalId } : {}),
  ...(row.provider === 'stripe' && row.ref && row.status !== 'captured' ? { reason: row.ref } : {}),
});

async function findPayment(env: Env, id: string) {
  return db(env).select().from(payments).where(eq(payments.id, id)).get();
}

async function recordPayment(
  env: Env,
  p: {
    id: string;
    orderId: string;
    kind: string;
    amount: number;
    status: string;
    provider: Provider;
    currency: string;
    ref?: string;
    externalId?: string;
  },
): Promise<PaymentResult> {
  const d = db(env);
  await d
    .insert(payments)
    .values({ ...p, createdAt: Date.now() })
    .onConflictDoNothing();
  // A retried step returns what the first attempt recorded, not what this one asked for.
  const row = await findPayment(env, p.id);
  if (row?.provider === 'stripe') return resultOf(row);
  return { paymentId: p.id, amount: row?.amount ?? p.amount, status: row?.status ?? p.status };
}

/** The provider recorded for a payment Stripe does not process. */
const localProvider = (env: Env, source?: PaymentSource): Provider =>
  source === 'external' || source === 'offline' ? source : stripeMode(env) ? 'offline' : 'mock';

/** What the order and the customer's account say the order can be paid with. */
async function savedPayment(env: Env, order: Order): Promise<SavedPayment> {
  const row = order.customerId
    ? await db(env)
        .select({
          stripeCustomerId: customers.stripeCustomerId,
          paymentMethodId: customers.stripePaymentMethodId,
        })
        .from(customers)
        .where(eq(customers.id, order.customerId))
        .get()
    : undefined;
  return {
    stripeCustomerId: order.payment?.stripeCustomerId ?? row?.stripeCustomerId ?? null,
    paymentMethodId: row?.paymentMethodId ?? null,
  };
}

/**
 * The payment method a new PaymentIntent confirms with. With a test key, an order that gives none
 * pays with Stripe's test card, and `meta.simulate` swaps in the test card that is always declined.
 */
function paymentMethodFor(
  stripe: Stripe,
  source: PaymentSource,
  order: Order,
  saved: SavedPayment,
  decline: boolean,
): string | null {
  if (stripe.testMode && decline) return 'pm_card_visa_chargeDeclined';
  if (source === 'confirm') return order.payment?.paymentMethodId ?? null;
  if (source === 'off_session') return saved.paymentMethodId ?? null;
  return stripe.testMode ? 'pm_card_visa' : null;
}

/** Why a PaymentIntent made elsewhere cannot pay for this order, or null when it can. */
async function adoptProblem(env: Env, pi: PaymentIntent, order: Order): Promise<string | null> {
  const amount = toMinor(order.total, order.currency);
  if (pi.currency !== order.currency.toLowerCase())
    return `PaymentIntent is in ${pi.currency.toUpperCase()}, the order in ${order.currency}`;
  if (pi.amount !== amount)
    return `PaymentIntent is for ${pi.amount}, the order for ${amount} (minor units)`;
  if (pi.status !== 'requires_capture')
    return `PaymentIntent is ${pi.status}, not an open authorization`;
  if (pi.metadata?.order_id && pi.metadata.order_id !== order.id)
    return `PaymentIntent belongs to order ${pi.metadata.order_id}`;
  const other = await db(env)
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(eq(payments.externalId, pi.id))
    .all();
  const taken = other.find((r) => r.orderId !== order.id);
  return taken ? `PaymentIntent already pays order ${taken.orderId}` : null;
}

// ── Authorize ─────────────────────────────────────────────────────────────

/**
 * `hold` places an authorization for the order total (status `authorized`, captured later).
 * `verify` checks the card, saves it on the customer for off-session charges, and releases the
 * hold at once (status `verified`), so nothing is left open for a capture that never comes.
 */
export async function authorizePayment(
  env: Env,
  order: Order,
  stepKey: string,
  method: string,
  purpose: PaymentPurpose = 'hold',
): Promise<PaymentResult> {
  const id = rowId('pay', order.id, stepKey);
  const kind = `authorization:${method}`;
  const ok = purpose === 'verify' ? 'verified' : 'authorized';
  const declined = simulate(order) === 'payment_decline';
  const base = { id, orderId: order.id, kind, amount: order.total, currency: order.currency };

  if (!stripeMode(env)) {
    const provider = order.payment?.provider === 'external' ? 'external' : 'mock';
    return recordPayment(env, { ...base, provider, status: declined ? 'declined' : ok });
  }

  const done = await findPayment(env, id);
  if (done) return resultOf(done);
  const stripe = stripeFor(env);
  const saved = await savedPayment(env, order);
  const source = paymentSource(order, method, saved);
  if (source === 'external' || source === 'offline')
    return recordPayment(env, { ...base, provider: source, status: declined ? 'declined' : ok });

  const decline = (reason: string, intentId?: string) =>
    recordPayment(env, {
      ...base,
      provider: 'stripe',
      status: 'declined',
      ref: reason,
      externalId: intentId,
    });

  let pi: PaymentIntent;
  try {
    if (source === 'adopt') {
      pi = await stripe.paymentIntents.retrieve(order.payment!.intentId!);
      const problem = await adoptProblem(env, pi, order);
      if (problem) return decline(problem, pi.id);
    } else {
      const pm = paymentMethodFor(stripe, source, order, saved, declined);
      if (!pm) return decline('No payment method on the order or the customer');
      const customer =
        purpose === 'verify'
          ? await ensureCustomer(env, stripe, order)
          : (order.payment?.stripeCustomerId ??
            (source === 'off_session' ? saved.stripeCustomerId : undefined));
      pi = await stripe.paymentIntents.create(
        {
          amount: toMinor(order.total, order.currency),
          currency: order.currency.toLowerCase(),
          capture_method: 'manual',
          confirm: true,
          payment_method: pm,
          customer: customer ?? undefined,
          off_session: source === 'off_session' ? true : undefined,
          setup_future_usage:
            purpose === 'verify' && source !== 'off_session' ? 'off_session' : undefined,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: order.title,
          metadata: { order_id: order.id, step: stepKey },
        },
        id,
      );
    }
  } catch (err) {
    if (err instanceof StripeError && err.isCardError)
      return decline(err.declineCode ?? err.code ?? err.message, err.paymentIntent?.id);
    rethrow(err);
  }

  if (pi.status !== 'requires_capture')
    return decline(
      pi.status === 'requires_action' ? 'authentication_required' : `PaymentIntent is ${pi.status}`,
      pi.id,
    );

  if (purpose === 'verify') {
    await stripe.paymentIntents.cancel(pi.id, {}, `${id}_release`).catch(rethrow);
    if (order.customerId && pi.payment_method)
      await db(env)
        .update(customers)
        .set({
          stripePaymentMethodId: pi.payment_method,
          ...(pi.customer ? { stripeCustomerId: pi.customer } : {}),
        })
        .where(eq(customers.id, order.customerId));
  }
  return recordPayment(env, {
    ...base,
    provider: 'stripe',
    status: ok,
    externalId: pi.id,
  });
}

// ── Void ──────────────────────────────────────────────────────────────────

/**
 * Compensation: void every open authorization for the order. Idempotent: Stripe cancels first (an
 * intent that is already canceled counts), and D1 changes only after it has; an intent captured in
 * the meantime is left to the capture.
 */
export async function voidAuthorizations(env: Env, orderId: string) {
  const d = db(env);
  const open = await d
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'authorized')));
  let voided = 0;
  for (const row of open) {
    if (row.provider === 'stripe' && row.externalId) {
      const stripe = stripeFor(env);
      try {
        await stripe.paymentIntents.cancel(row.externalId, {}, rowId('void', row.id));
      } catch (err) {
        if (!(err instanceof StripeError) || err.code !== 'payment_intent_unexpected_state')
          rethrow(err);
        const status =
          err.paymentIntent?.status ??
          (await stripe.paymentIntents.retrieve(row.externalId).catch(rethrow)).status;
        if (status !== 'canceled') continue;
      }
    }
    const res = await d
      .update(payments)
      .set({ status: 'voided' })
      .where(and(eq(payments.id, row.id), eq(payments.status, 'authorized')))
      .returning();
    voided += res.length;
  }
  return voided;
}

/**
 * Stripe canceled a PaymentIntent (it expired, or someone canceled it in the Dashboard): its open
 * authorization is voided. Returns the orders whose payment changed.
 */
export async function markIntentCanceled(env: Env, intentId: string) {
  const res = await db(env)
    .update(payments)
    .set({ status: 'voided' })
    .where(
      and(
        eq(payments.externalId, intentId),
        eq(payments.provider, 'stripe'),
        eq(payments.status, 'authorized'),
      ),
    )
    .returning({ orderId: payments.orderId });
  return res.map((r) => r.orderId);
}

/** The order a Stripe PaymentIntent pays, if OrderLoop made or adopted it. */
export async function orderForIntent(env: Env, intentId: string) {
  const row = await db(env)
    .select({ orderId: payments.orderId })
    .from(payments)
    .where(and(eq(payments.externalId, intentId), eq(payments.provider, 'stripe')))
    .get();
  return row?.orderId ?? null;
}

// ── Capture ───────────────────────────────────────────────────────────────

export async function capturePayment(env: Env, order: Order, stepKey: string) {
  const d = db(env);
  const id = `cap_${stepKey}_${order.id}`.replace(/[^\w-]/g, '_');
  const failed = { paymentId: null, amount: 0, status: 'failed' };
  // A retry after the capture was recorded returns it rather than looking for an open authorization.
  const done = await findPayment(env, id);
  if (done) return { paymentId: id, amount: done.amount, status: done.status };
  const [auth] = await d
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.status, 'authorized')));
  if (!auth) return failed;
  // Never more than the order now costs: lines dropped after authorizing (a seller rejecting
  // their part) are released, not charged.
  const amount = money(Math.min(auth.amount, order.total));
  const currency = auth.currency ?? order.currency;
  if (auth.provider === 'stripe' && auth.externalId) {
    const stripe = stripeFor(env);
    try {
      await stripe.paymentIntents.capture(
        auth.externalId,
        { amount_to_capture: toMinor(amount, currency) },
        id,
      );
    } catch (err) {
      // Voided before the capture reached it: nothing to capture.
      if (err instanceof StripeError && err.code === 'payment_intent_unexpected_state') {
        if (err.paymentIntent?.status !== 'succeeded') return failed;
      } else rethrow(err);
    }
  }
  // One transaction: the authorization flips only if still open, and the capture is recorded only
  // if this call flipped it, so a void racing the capture leaves exactly one of them.
  await d.batch([
    d
      .update(payments)
      .set({ status: 'captured', ref: id })
      .where(and(eq(payments.id, auth.id), eq(payments.status, 'authorized'))),
    d
      .insert(payments)
      .select(
        d
          .select({
            id: sql`${id}`.as('id'),
            orderId: sql`${order.id}`.as('order_id'),
            kind: sql`'capture'`.as('kind'),
            amount: sql`${amount}`.as('amount'),
            status: sql`'succeeded'`.as('status'),
            ref: sql`${auth.id}`.as('ref'),
            createdAt: sql`${Date.now()}`.as('created_at'),
            provider: sql`${auth.provider}`.as('provider'),
            externalId: sql`${auth.externalId}`.as('external_id'),
            currency: sql`${currency}`.as('currency'),
          })
          .from(payments)
          .where(
            and(eq(payments.id, auth.id), eq(payments.status, 'captured'), eq(payments.ref, id)),
          ),
      )
      .onConflictDoNothing(),
  ]);
  const row = await findPayment(env, id);
  return row ? { paymentId: id, amount: row.amount, status: row.status } : failed;
}

// ── Charge ────────────────────────────────────────────────────────────────

/** Charges the order total at once (a subscription renewal): off-session with the saved card. */
export async function charge(env: Env, order: Order, stepKey: string): Promise<PaymentResult> {
  const id = rowId('chg', order.id, stepKey);
  const fail = simulate(order) === 'charge_fail';
  const base = { id, orderId: order.id, kind: 'charge', amount: order.total };
  const currency = order.currency;

  if (!stripeMode(env)) {
    const provider = order.payment?.provider === 'external' ? 'external' : 'mock';
    return recordPayment(env, {
      ...base,
      currency,
      provider,
      status: fail ? 'failed' : 'succeeded',
    });
  }

  const done = await findPayment(env, id);
  if (done) return resultOf(done);
  const stripe = stripeFor(env);
  const saved = await savedPayment(env, order);
  if (!saved.paymentMethodId) Object.assign(saved, await verifiedCard(env, stripe, order.id));
  // An intent the order arrived with paid for its first payment, not this one.
  const payment = order.payment && { ...order.payment, intentId: undefined };
  const source = paymentSource({ payment }, 'card', saved);
  if (source === 'external')
    return recordPayment(env, {
      ...base,
      currency,
      provider: source,
      status: fail ? 'failed' : 'succeeded',
    });

  const failed = (reason: string, intentId?: string) =>
    recordPayment(env, {
      ...base,
      currency,
      provider: 'stripe',
      status: 'failed',
      ref: reason,
      externalId: intentId,
    });
  const pm = paymentMethodFor(stripe, source, order, saved, fail);
  if (!pm) return failed('No saved payment method to charge');
  const customer =
    order.payment?.stripeCustomerId ??
    (source === 'off_session' ? (saved.stripeCustomerId ?? undefined) : undefined);
  let pi: PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: toMinor(order.total, currency),
        currency: currency.toLowerCase(),
        confirm: true,
        payment_method: pm,
        customer,
        off_session: customer ? true : undefined,
        automatic_payment_methods: customer
          ? undefined
          : { enabled: true, allow_redirects: 'never' },
        description: order.title,
        metadata: { order_id: order.id, step: stepKey },
      },
      id,
    );
  } catch (err) {
    if (err instanceof StripeError && err.isCardError)
      return failed(err.declineCode ?? err.code ?? err.message, err.paymentIntent?.id);
    rethrow(err);
  }
  if (pi.status !== 'succeeded') return failed(`PaymentIntent is ${pi.status}`, pi.id);
  return recordPayment(env, {
    ...base,
    currency,
    provider: 'stripe',
    status: 'succeeded',
    externalId: pi.id,
  });
}

/** A guest's card, saved by this order's `verify` authorization (guests have no account to hold it). */
async function verifiedCard(env: Env, stripe: Stripe, orderId: string): Promise<SavedPayment> {
  const row = await db(env)
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.provider, 'stripe'),
        eq(payments.status, 'verified'),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .get();
  if (!row?.externalId) return {};
  const pi = await stripe.paymentIntents.retrieve(row.externalId).catch(rethrow);
  return pi.customer && pi.payment_method
    ? { stripeCustomerId: pi.customer, paymentMethodId: pi.payment_method }
    : {};
}

/** A supplier payment (accounts payable): recorded, never sent to the card processor. */
export function paySupplier(env: Env, order: Order, stepKey: string) {
  return recordPayment(env, {
    id: rowId('chg', order.id, `ap_${stepKey}`),
    orderId: order.id,
    kind: 'charge',
    amount: order.total,
    status: 'succeeded',
    currency: order.currency,
    provider: localProvider(env),
  });
}

// ── Refund ────────────────────────────────────────────────────────────────

const isPaid = (p: PaymentRow) =>
  p.status === 'succeeded' && (p.kind === 'capture' || p.kind === 'charge');
const isRefund = (p: PaymentRow) => p.kind === 'refund' && p.status === 'succeeded';
const sum = (rows: PaymentRow[]) => rows.reduce((s, p) => s + p.amount, 0);

/**
 * Refunds up to `requested` (everything still refundable when omitted) of the money captured or
 * charged on the order. Keyed by step: a retried step returns the refund it already made.
 *
 * When any of that money went through Stripe, the refund is spread over the payments newest first,
 * one refund row (and Stripe refund) per payment it draws on: `rfd_…`, then `rfd_…_1`, `rfd_…_2`.
 */
export async function refund(
  env: Env,
  order: Order,
  stepKey: string,
  requested?: number,
): Promise<PaymentResult> {
  const d = db(env);
  const id = rowId('rfd', order.id, stepKey);
  const rows = await d.select().from(payments).where(eq(payments.orderId, order.id));
  if (rows.some((p) => isPaid(p) && p.provider === 'stripe'))
    return refundAcross(env, order, id, rows, requested);

  const done = rows.find((p) => p.id === id);
  if (done) return { paymentId: id, amount: done.amount, status: done.status };
  const refundable = money(sum(rows.filter(isPaid)) - sum(rows.filter(isRefund)));
  const amount = money(Math.min(requested ?? refundable, refundable));
  if (amount <= 0) return { paymentId: null, amount: 0, status: 'failed' };
  return recordPayment(env, {
    id,
    orderId: order.id,
    kind: 'refund',
    amount,
    status: 'succeeded',
    currency: order.currency,
    provider: localProvider(env),
  });
}

async function refundAcross(
  env: Env,
  order: Order,
  id: string,
  rows: PaymentRow[],
  requested: number | undefined,
): Promise<PaymentResult> {
  // This step's own parts are left out of the plan, so a retry plans exactly what it did before.
  const mine = (p: PaymentRow) => p.id === id || p.id.startsWith(`${id}_`);
  const others = rows.filter((p) => !mine(p));
  const paid = others
    .filter(isPaid)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const refunds = others.filter(isRefund);
  const refundable = money(sum(paid) - sum(refunds));
  let left = money(Math.min(requested ?? refundable, refundable));
  if (left <= 0) {
    const made = rows.filter(mine);
    return made.length
      ? { paymentId: id, amount: money(sum(made)), status: 'succeeded' }
      : { paymentId: null, amount: 0, status: 'failed' };
  }

  // What each payment still has to give back; refunds that name no payment come off the newest.
  let unattributed = sum(refunds.filter((r) => !paid.some((p) => p.id === r.ref)));
  const plan: { payment: PaymentRow; amount: number }[] = [];
  for (const p of paid) {
    let room = money(p.amount - sum(refunds.filter((r) => r.ref === p.id)));
    const taken = Math.min(room, unattributed);
    room = money(room - taken);
    unattributed = money(unattributed - taken);
    const amount = money(Math.min(room, left));
    if (amount <= 0) continue;
    plan.push({ payment: p, amount });
    left = money(left - amount);
    if (left <= 0) break;
  }

  const stripe = plan.some((x) => x.payment.provider === 'stripe') ? stripeFor(env) : null;
  const ids = plan.map((_, i) => (i === 0 ? id : `${id}_${i}`));
  const existing = new Set(
    (await db(env).select({ id: payments.id }).from(payments).where(inArray(payments.id, ids))).map(
      (r) => r.id,
    ),
  );
  for (const [i, part] of plan.entries()) {
    const partId = ids[i]!;
    if (existing.has(partId)) continue;
    const currency = part.payment.currency ?? order.currency;
    let externalId: string | undefined;
    let status = 'succeeded';
    if (part.payment.provider === 'stripe' && part.payment.externalId && stripe) {
      const r = await stripe.refunds
        .create(
          {
            payment_intent: part.payment.externalId,
            amount: toMinor(part.amount, currency),
            metadata: { order_id: order.id, payment_id: part.payment.id },
          },
          partId,
        )
        .catch(rethrow);
      externalId = r.id;
      if (r.status === 'failed' || r.status === 'canceled') status = 'failed';
    }
    await recordPayment(env, {
      id: partId,
      orderId: order.id,
      kind: 'refund',
      amount: part.amount,
      status,
      currency,
      provider: part.payment.provider as Provider,
      ref: part.payment.id,
      externalId,
    });
  }
  const made = (await db(env).select().from(payments).where(inArray(payments.id, ids))).filter(
    isRefund,
  );
  const amount = money(sum(made));
  return amount > 0
    ? { paymentId: id, amount, status: 'succeeded' }
    : { paymentId: null, amount: 0, status: 'failed' };
}

/** Money captured or charged on the order, before refunds. */
export async function paidAmount(env: Env, orderId: string) {
  const rows = await db(env).select().from(payments).where(eq(payments.orderId, orderId));
  return money(sum(rows.filter(isPaid)));
}
