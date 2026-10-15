/**
 * Where an order's payment comes from. Pure: the engine's payment gateway reads it to decide which
 * Stripe call (if any) an authorize or charge step makes.
 */

import type { Order } from './types';

/**
 * - `external`: the channel already took the money (`payment.provider = 'external'`).
 * - `offline`: the node's method is not a card Stripe handles (cash, terms, a till's terminal).
 * - `adopt`: the order names a PaymentIntent created elsewhere (a checkout); check it and use it.
 * - `confirm`: the order names a payment method; create and confirm a PaymentIntent with it.
 * - `off_session`: no method on the order, but the customer has one saved; charge it off-session.
 * - `none`: nothing to pay with.
 */
export const PAYMENT_SOURCES = [
  'external',
  'offline',
  'adopt',
  'confirm',
  'off_session',
  'none',
] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

/** `commerce.authorize_payment` methods that never reach a card processor. */
export const OFFLINE_PAYMENT_METHODS = ['card_present', 'cash', 'gift_card', 'ach', 'terms'];

/** A payment method saved on the customer's account (by a `verify` authorization). */
export type SavedPayment = {
  stripeCustomerId?: string | null;
  paymentMethodId?: string | null;
};

export function paymentSource(
  order: Pick<Order, 'payment'>,
  method = 'card',
  saved: SavedPayment = {},
): PaymentSource {
  const p = order.payment;
  if (p?.provider === 'external') return 'external';
  if (OFFLINE_PAYMENT_METHODS.includes(method)) return 'offline';
  if (p?.intentId) return 'adopt';
  if (p?.paymentMethodId) return 'confirm';
  if (saved.paymentMethodId && (p?.stripeCustomerId ?? saved.stripeCustomerId))
    return 'off_session';
  return 'none';
}
