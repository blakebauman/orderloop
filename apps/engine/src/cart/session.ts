/**
 * A cart as the checkout pricing sees it: the session `quoteCheckout` prices and what the draft
 * order adds (the customer, for contract prices and credit, and the promo codes). The agent prices
 * the cart with these, and a cart search its products, so both see the same order.
 */

import { BASE_CURRENCY, type Cart, type CheckoutSession } from '@orderloop/core';
import type { DraftExtra } from '../ucp/quote';

export function cartSession(c: Cart): CheckoutSession {
  return {
    id: c.id,
    ownerId: c.createdBy,
    status: 'incomplete',
    currency: BASE_CURRENCY,
    lines: c.lines,
    buyer: {},
    fulfillment: 'ship',
    shipTo: c.shipTo,
    shippingOption: c.shippingOption,
    quote: null,
    issues: [],
    orderId: null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    expiresAt: c.external?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    version: c.version,
  };
}

export function cartDraftExtra(c: Cart): DraftExtra {
  return {
    channel: 'manual',
    ...(c.customerId ? { customerId: c.customerId } : {}),
    meta: c.promoCodes.length ? { promoCodes: c.promoCodes } : {},
  };
}
