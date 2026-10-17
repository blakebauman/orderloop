/**
 * Completing a checkout takes the platform's payment instrument and places the hold the order's
 * authorize node will adopt (`order.payment.intentId`, the `adopt` source in @orderloop/core's
 * payments.ts). The PaymentIntent is keyed by the session, the PaymentMethod and the amount, so a
 * completion retried after a lost answer replays the same hold rather than placing a second one.
 */

import {
  type CheckoutSession,
  type OrderPayment,
  toMinor,
  type UcpInstrument,
} from '@orderloop/core';
import { stripeFor, stripeMode } from '../gateway';
import { StripeError } from '../stripe';
import { STRIPE_HANDLER, TEST_HANDLER } from './config';

export type Authorized =
  | { ok: true; payment?: OrderPayment }
  | { ok: false; code: string; content: string };

const declined = (content: string): Authorized => ({ ok: false, code: 'payment_failed', content });

/** Places the hold for the session's total with the instrument's handler. */
export async function authorizeCheckout(
  env: Env,
  s: CheckoutSession,
  handlerName: string,
  instrument: UcpInstrument,
): Promise<Authorized> {
  const token = instrument.credential?.token;
  if (handlerName === TEST_HANDLER) {
    if (stripeMode(env)) return declined('The test payment handler is not available.');
    return token === 'tok_test_decline' ? declined('The test card was declined.') : { ok: true };
  }
  if (handlerName !== STRIPE_HANDLER) return declined('That payment handler is not offered.');
  if (instrument.credential?.type !== 'stripe_payment_method' || !token || !/^pm_\w+$/.test(token))
    return declined('Send a Stripe PaymentMethod (pm_…) as a stripe_payment_method credential.');
  const stripe = stripeFor(env);
  const amount = toMinor(s.quote?.total ?? 0, s.currency);
  const key = `ucp_${s.id}_${token}_${amount}`;
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount,
        currency: s.currency.toLowerCase(),
        capture_method: 'manual',
        confirm: true,
        payment_method: token,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: `Checkout ${s.id}`,
        metadata: { checkout_id: s.id, ucp_platform: s.ownerId },
      },
      key,
    );
    if (pi.status === 'requires_capture')
      return { ok: true, payment: { provider: 'stripe', intentId: pi.id } };
    // Anything else (authentication required, processing) can't become an order's hold.
    await stripe.paymentIntents.cancel(pi.id, {}, `${key}_cancel`).catch(() => {});
    return declined(
      pi.status === 'requires_action'
        ? 'The card needs the buyer to authenticate, which this checkout cannot do; use another card.'
        : `The payment could not be held (${pi.status}).`,
    );
  } catch (err) {
    if (err instanceof StripeError && err.isCardError)
      return declined(`The card was declined${err.declineCode ? ` (${err.declineCode})` : ''}.`);
    throw err;
  }
}

/**
 * Releases a hold no order took: the order failed before (or instead of) adopting it. Idempotent;
 * an intent already captured or canceled is left alone.
 */
export async function releaseHold(env: Env, intentId: string) {
  if (!stripeMode(env)) return;
  const stripe = stripeFor(env);
  try {
    const pi = await stripe.paymentIntents.retrieve(intentId);
    if (pi.status === 'requires_capture')
      await stripe.paymentIntents.cancel(intentId, {}, `ucp_release_${intentId}`);
  } catch (err) {
    if (!(err instanceof StripeError) || err.isRetryable) throw err;
  }
}
