import type { OrderInput } from '@orderloop/core';

/** One-click demo orders. Each exercises a different path through a seeded flow. */
export type Scenario = {
  id: string;
  label: string;
  blurb: string;
  flowId: string;
  input: OrderInput;
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'b2b-email',
    label: 'B2B PO by email',
    blurb:
      'AI extracts lines from an email, contract pricing, agent auto-approves, ships, waits for payment.',
    flowId: 'tpl-b2b-order',
    input: {
      model: 'b2b',
      channel: 'email',
      currency: 'USD',
      lines: [],
      meta: {},
      documentText:
        'From: Northwind Traders\nSubject: PO #NW-7781\n\nHi team, please ship 120 x WID-100 (industrial widgets), 40 x GSK-010 gasket kits and 8 x WID-200.\nDeliver to dock 4. Thanks, Priya — Purchasing',
    },
  },
  {
    id: 'b2b-credit',
    label: 'B2B over credit limit',
    blurb: 'Contoso is near its limit: credit check fails over to a human approval.',
    flowId: 'tpl-b2b-order',
    input: {
      model: 'b2b',
      channel: 'api',
      currency: 'USD',
      customerId: 'cus_contoso',
      title: 'PO CT-2209',
      lines: [{ sku: 'WID-200', qty: 60 }],
      meta: {},
    },
  },
  {
    id: 'b2b-rollback',
    label: 'B2B out of stock',
    blurb:
      'Reservation comes up short; the order fails and Workflows rolls back compensable steps.',
    flowId: 'tpl-b2b-order',
    input: {
      model: 'b2b',
      channel: 'api',
      currency: 'USD',
      customerId: 'cus_fabrikam',
      lines: [{ sku: 'MTR-750', qty: 4 }],
      meta: { simulate: 'out_of_stock' },
    },
  },
  {
    id: 'purchase',
    label: 'Purchase request',
    blurb:
      'Eight laptops: AI classifies spend, manager then finance approve, PO, supplier ack, 3-way match.',
    flowId: 'tpl-purchase-request',
    input: {
      model: 'procurement',
      channel: 'manual',
      currency: 'USD',
      customerId: 'cus_internal',
      title: 'Laptops for the new support team',
      lines: [
        { sku: 'LAP-14', qty: 8 },
        { sku: 'MON-27', qty: 8 },
      ],
      meta: {},
    },
  },
  {
    id: 'reorder',
    label: 'Reorder (stock review)',
    blurb: 'Forecast finds SKUs below their reorder point and drafts a replenishment PO.',
    flowId: 'tpl-reorder',
    input: {
      model: 'replenishment',
      channel: 'schedule',
      currency: 'USD',
      customerId: 'cus_internal',
      title: 'Manual stock review',
      lines: [],
      meta: {},
    },
  },
  {
    id: 'subscription',
    label: 'Subscription',
    blurb: 'Coffee box: authorize, then a monthly loop of wait → charge → ship (time-compressed).',
    flowId: 'tpl-subscription',
    input: {
      model: 'subscription',
      channel: 'web',
      currency: 'USD',
      customerId: 'cus_ada',
      title: 'Monthly coffee box',
      lines: [{ sku: 'SUB-BOX', qty: 1 }],
      meta: {},
    },
  },
  {
    id: 'subscription-dunning',
    label: 'Subscription, card fails',
    blurb: 'Renewal and its retry both fail: the subscription pauses.',
    flowId: 'tpl-subscription',
    input: {
      model: 'subscription',
      channel: 'web',
      currency: 'USD',
      customerId: 'cus_ada',
      title: 'Coffee box (expired card)',
      lines: [{ sku: 'SUB-BOX', qty: 1 }],
      meta: { simulate: 'charge_fail' },
    },
  },
  {
    id: 'storefront-return',
    label: 'Storefront order, returned',
    blurb:
      'Card checkout ships and captures, then the customer returns it: RMA label, restock, refund.',
    flowId: 'tpl-storefront-order',
    input: {
      model: 'b2c',
      channel: 'web',
      currency: 'USD',
      customerId: 'cus_ada',
      title: 'Web order #10482',
      lines: [{ sku: 'MON-27', qty: 1 }],
      meta: {},
    },
  },
  {
    id: 'storefront-eur',
    label: 'Storefront order in euros',
    blurb:
      'The same checkout priced in EUR: USD list prices convert at the stored rate, and the invoice, refunds and webhooks carry EUR.',
    flowId: 'tpl-storefront-order',
    input: {
      model: 'b2c',
      channel: 'web',
      currency: 'EUR',
      customerId: 'cus_ada',
      title: 'Web order #10517',
      lines: [
        { sku: 'MON-27', qty: 1 },
        { sku: 'GSK-010', qty: 4 },
      ],
      meta: {},
    },
  },
];
