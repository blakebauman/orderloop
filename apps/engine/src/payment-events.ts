/**
 * Stripe's webhook events, verified by the web app (`POST /api/v1/webhooks/stripe`) and handed over
 * through `EngineRpc.paymentEvent`.
 *
 *   invoice.paid             settle the invoice (./billing), then deliver `payment.received`
 *   payment_intent.canceled  the authorization it held is voided
 *   charge.dispute.created   deliver `payment.disputed` to a node waiting for it
 *
 * Each event id is claimed in `payment_events` before it is acted on: Stripe redelivers for up to
 * three days, far past the signed-webhook receipts' window, and a repeat (or a concurrent second
 * delivery) does nothing. The claim is dropped when the outcome is `retry` or the handling throws,
 * so Stripe's next delivery tries again. Settling is idempotent, so a retried `invoice.paid`
 * changes nothing before it delivers.
 */

import {
  fromMinor,
  type OrderState,
  type PaymentEvent,
  type PaymentEventResult,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import { createDb, paymentEvents } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { settleInvoice } from './billing';
import { orderAgent } from './namespaces';
import { markIntentCanceled, orderForIntent } from './payments';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The id of an expandable field: `"pi_…"` or `{ id: "pi_…" }`. */
const idOf = (v: unknown) => str(v) ?? str((v as { id?: unknown } | null)?.id);

export async function handleStripeEvent(
  env: Env,
  event: PaymentEvent,
): Promise<PaymentEventResult> {
  const d = createDb(env.DB);
  const [claimed] = await d
    .insert(paymentEvents)
    .values({ id: event.id, provider: 'stripe', type: event.type, receivedAt: Date.now() })
    .onConflictDoNothing()
    .returning();
  if (!claimed) return { outcome: 'duplicate' };
  let result: PaymentEventResult | undefined;
  try {
    result = await dispatch(env, event);
    if (result.orderId)
      await d
        .update(paymentEvents)
        .set({ orderId: result.orderId })
        .where(eq(paymentEvents.id, event.id));
    return result;
  } finally {
    if (!result || result.outcome === 'retry')
      await d.delete(paymentEvents).where(eq(paymentEvents.id, event.id));
  }
}

async function dispatch(env: Env, event: PaymentEvent): Promise<PaymentEventResult> {
  const obj = event.data.object;
  switch (event.type) {
    case 'invoice.paid': {
      const id = str(obj.id);
      if (!id) return { outcome: 'ignored', reason: 'No invoice id' };
      const currency = str(obj.currency)?.toUpperCase();
      const paidMinor = num(obj.amount_paid);
      const settled = await settleInvoice(
        env,
        id,
        paidMinor !== undefined && currency ? fromMinor(paidMinor, currency) : undefined,
      );
      if (!settled) return { outcome: 'ignored', reason: 'Not an OrderLoop invoice' };
      return deliver(env, settled.row.orderId, 'payment.received', {
        provider: 'stripe',
        invoiceId: id,
        invoiceNumber: settled.row.number,
        amount: settled.row.amount,
        currency: settled.row.currency,
      });
    }
    case 'payment_intent.canceled': {
      const id = str(obj.id);
      if (!id) return { outcome: 'ignored', reason: 'No PaymentIntent id' };
      const orders = await markIntentCanceled(env, id);
      const orderId = orders[0] ?? (await orderForIntent(env, id)) ?? undefined;
      return orderId ? { outcome: 'handled', orderId } : { outcome: 'ignored' };
    }
    case 'charge.dispute.created': {
      const intent = idOf(obj.payment_intent);
      const orderId = intent ? await orderForIntent(env, intent) : null;
      if (!orderId) return { outcome: 'ignored', reason: 'Not an OrderLoop payment' };
      // Most flows don't wait for a dispute: one that has no wait open is told nothing, rather
      // than retried for days. A flow that wants disputes waits on `payment.disputed`.
      const r = await deliver(env, orderId, 'payment.disputed', {
        provider: 'stripe',
        disputeId: str(obj.id),
        amount:
          num(obj.amount) !== undefined && str(obj.currency)
            ? fromMinor(num(obj.amount)!, str(obj.currency)!.toUpperCase())
            : undefined,
        currency: str(obj.currency)?.toUpperCase(),
        reason: str(obj.reason),
      });
      return r.outcome === 'retry' ? { outcome: 'handled', orderId, reason: 'No wait open' } : r;
    }
    default:
      return { outcome: 'ignored', reason: `Not handled: ${event.type}` };
  }
}

/**
 * Delivers an order event to the node waiting for it. With no wait open, an order still running
 * may open one later (the invoice node runs before the wait), so the outcome is `retry`; a finished
 * order never will.
 */
async function deliver(
  env: Env,
  orderId: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<PaymentEventResult> {
  const agent = orderAgent(env, orderId);
  const state = (await agent.snapshot()) as OrderState;
  if (!state.orderId) return { outcome: 'ignored', orderId, reason: 'Unknown order' };
  const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
  const r = await agent.deliver(name, clean);
  if (r.delivered) return { outcome: 'handled', orderId, delivered: name };
  if (TERMINAL_ORDER_STATUSES.includes(state.status))
    return { outcome: 'handled', orderId, reason: `Order is ${state.status}` };
  return { outcome: 'retry', orderId, reason: `No node is waiting for ${name} yet` };
}
