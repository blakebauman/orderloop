/**
 * What the payment gateway (./payments) and Stripe billing (./billing) share: the mode, the client,
 * how a failed Stripe call fails the step, and the customer's Stripe customer.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import type { Order } from '@orderloop/core';
import { createDb, customers } from '@orderloop/db';
import { and, eq, sql } from 'drizzle-orm';
import { StripeError, stripeClient } from './stripe';

/** A row id from its parts, safe for D1 and as a Stripe idempotency key. */
export const rowId = (prefix: string, ...parts: string[]) =>
  `${prefix}_${parts.join('_')}`.replace(/[^\w-]/g, '_');

/** True when new payments go to Stripe. Any mode other than "mock" or "stripe" is a config error. */
export function stripeMode(env: Env): boolean {
  const mode = String(env.PAYMENTS_MODE ?? 'mock');
  if (mode === 'mock') return false;
  if (mode === 'stripe') return true;
  throw new NonRetryableError(`Unknown PAYMENTS_MODE "${mode}": use "mock" or "stripe"`);
}

/** The Stripe client, or a permanent failure when no key is configured. */
export function stripeFor(env: Env) {
  if (!env.STRIPE_SECRET_KEY)
    throw new NonRetryableError(
      'Stripe payments need STRIPE_SECRET_KEY: set the secret, or PAYMENTS_MODE to "mock"',
    );
  return stripeClient(env.STRIPE_SECRET_KEY);
}

export type Stripe = ReturnType<typeof stripeFor>;

/**
 * Rethrows a failed Stripe call: Stripe's own failures, rate limits and network errors throw as-is
 * so the step retries with the same key; a request Stripe refuses (bad parameters, wrong state)
 * would be refused again, so it fails the step for good.
 */
export function rethrow(err: unknown): never {
  if (err instanceof StripeError && !err.isRetryable && !err.isCardError)
    throw new NonRetryableError(`Stripe: ${err.message}${err.code ? ` (${err.code})` : ''}`);
  throw err;
}

/**
 * The order's Stripe customer: given on the order, already on the account, or created once (keyed by
 * the account, so racing steps make one). A guest gets one per order, which is not stored.
 */
export async function ensureCustomer(env: Env, stripe: Stripe, order: Order): Promise<string> {
  if (order.payment?.stripeCustomerId) return order.payment.stripeCustomerId;
  const d = createDb(env.DB);
  const account = order.customerId
    ? await d.select().from(customers).where(eq(customers.id, order.customerId)).get()
    : undefined;
  if (account?.stripeCustomerId) return account.stripeCustomerId;
  const created = await stripe.customers
    .create(
      account
        ? { email: account.email, name: account.name, metadata: { customer_id: account.id } }
        : {
            email: order.contact?.email,
            name: order.contact?.name,
            metadata: { order_id: order.id },
          },
      account ? rowId('cust', account.id) : rowId('cust', order.id),
    )
    .catch(rethrow);
  if (!account) return created.id;
  await d
    .update(customers)
    .set({ stripeCustomerId: created.id })
    .where(and(eq(customers.id, account.id), sql`${customers.stripeCustomerId} is null`));
  const stored = await d
    .select({ id: customers.stripeCustomerId })
    .from(customers)
    .where(eq(customers.id, account.id))
    .get();
  return stored?.id ?? created.id;
}
