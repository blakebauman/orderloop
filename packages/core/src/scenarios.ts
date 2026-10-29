import type { OrderInput } from './order-schemas';

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
    id: 'guest-checkout',
    label: 'Guest checkout',
    blurb:
      'A web order from a shopper with no account: card checkout, and the shipping and return emails go to their contact address.',
    flowId: 'tpl-storefront-order',
    input: {
      model: 'b2c',
      channel: 'web',
      currency: 'USD',
      title: 'Web order #10601',
      contact: { email: 'sam.rivera@example.com', name: 'Sam Rivera' },
      lines: [{ sku: 'MON-27', qty: 1 }],
      meta: {},
    },
  },
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
    id: 'marketplace',
    label: 'Marketplace order, two sellers',
    blurb:
      'Headphones from a seller that auto-accepts and a kettle from one that is asked: the order waits for Kettle & Co, then ships what was accepted and pays each seller out net of commission.',
    flowId: 'tpl-marketplace-order',
    input: {
      model: 'marketplace',
      channel: 'marketplace',
      currency: 'USD',
      customerId: 'cus_ada',
      title: 'Marketplace order M-30417',
      lines: [
        { sku: 'HP-200', qty: 1 },
        { sku: 'KET-01', qty: 1 },
      ],
      meta: {},
    },
  },
  {
    id: 'pickup',
    label: 'Buy online, pick up in store',
    blurb:
      'A monitor held at the SoHo store with a pickup code; the order waits for pickup.collected, then hands it over and captures payment.',
    flowId: 'tpl-omnichannel-order',
    input: {
      model: 'd2c',
      channel: 'web',
      currency: 'USD',
      customerId: 'cus_ada',
      title: 'Web order #10655 (pickup)',
      fulfillment: { method: 'pickup', locationId: 'loc_soho' },
      lines: [{ sku: 'MON-27', qty: 1 }],
      meta: {},
    },
  },
  {
    id: 'ship-from-store',
    label: 'Ship from store, with an e-book',
    blurb:
      'The warehouse has no tees, so they ship from the SoHo store; the e-book is delivered as a code, and payment is captured once both parts are done.',
    flowId: 'tpl-omnichannel-order',
    input: {
      model: 'd2c',
      channel: 'mobile',
      currency: 'USD',
      contact: { email: 'jo.park@example.com', name: 'Jo Park' },
      title: 'App order #A-2291',
      lines: [
        { sku: 'TEE-01', qty: 2 },
        { sku: 'EBK-101', qty: 1 },
      ],
      meta: {
        shipTo: {
          line1: '200 Lafayette St',
          city: 'New York',
          region: 'NY',
          postalCode: '10012',
          country: 'US',
          latitude: 40.7215,
          longitude: -73.9977,
        },
      },
    },
  },
  {
    id: 'split-ship',
    label: 'Split shipment, nearest store',
    blurb:
      'Eight monitors and three tees to San Francisco: no one place has both, so the monitors ship from the warehouse and the tees from the Mission store, the nearest that has them.',
    flowId: 'tpl-omnichannel-order',
    input: {
      model: 'd2c',
      channel: 'web',
      currency: 'USD',
      customerId: 'cus_ada',
      title: 'Web order #10702 (split)',
      lines: [
        { sku: 'MON-27', qty: 8 },
        { sku: 'TEE-01', qty: 3 },
      ],
      meta: {
        shipTo: {
          line1: '1 Market St',
          city: 'San Francisco',
          region: 'CA',
          postalCode: '94105',
          country: 'US',
          latitude: 37.7946,
          longitude: -122.3947,
        },
      },
    },
  },
  {
    id: 'pos-sale',
    label: 'Till sale with a gift card',
    blurb:
      'A tee and a gift card sold at the Mission store: card present, the tee leaves store stock, the gift card gets a code, and the receipt is emailed.',
    flowId: 'tpl-pos-sale',
    input: {
      model: 'b2c',
      channel: 'pos',
      currency: 'USD',
      contact: { email: 'walk.in@example.com' },
      title: 'Till 3 · sale 0419',
      fulfillment: { method: 'carry_out', locationId: 'loc_mission' },
      lines: [
        { sku: 'TEE-01', qty: 1 },
        { sku: 'GFT-25', qty: 1 },
      ],
      meta: {},
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

/** An empty form, for a workspace without the demo data. */
export const BLANK_SCENARIO: Scenario = {
  id: 'blank',
  label: 'Blank',
  blurb: '',
  flowId: '',
  input: { model: 'b2b', channel: 'manual', currency: 'USD', lines: [], meta: {} },
};

/** The customers and SKUs the scenarios need: present only where the demo data was loaded. */
export const SCENARIO_CUSTOMERS = [
  ...new Set(SCENARIOS.flatMap((s) => (s.input.customerId ? [s.input.customerId] : []))),
];
export const SCENARIO_SKUS = [
  ...new Set(SCENARIOS.flatMap((s) => s.input.lines.map((l) => l.sku))),
];
