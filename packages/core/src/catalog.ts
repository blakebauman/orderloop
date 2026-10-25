/**
 * The node catalog: every node type's metadata, its config fields and its output branches.
 * The editor builds its palette and inspector forms from this; the engine pairs each type with an
 * executor (apps/engine/src/nodes). Config fields are the single source of truth for validation.
 */

import { z } from 'zod';
import { assessConfigErrors, assessOutputs, assessQuestionsSchema } from './assess';
import { policyRulesSchema } from './policy';
import { SHIPPING_SELECTIONS, shippingConfigSchema, taxRegionsSchema } from './shipping';

export type NodeCategory = 'trigger' | 'commerce' | 'control' | 'ai';

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: 'Triggers',
  commerce: 'Commerce',
  control: 'Control',
  ai: 'AI',
};

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'duration'
  /** A JSON Logic expression evaluated against the run context. */
  | 'logic'
  | 'json'
  | 'list'
  /** Who does the work: `builtin`, or the id of an installed plugin providing `surface`. */
  | 'provider';

/**
 * What a plugin can stand behind a built-in node to do (its manifest's `provides`). The node keeps
 * its contract: the core still applies totals, stock, shipments and branches from what the
 * provider returns. See docs/plugins.md, "Providers".
 */
export const PROVIDER_SURFACES = ['shipping.rates', 'shipping.labels', 'tax', 'address'] as const;
export type ProviderSurface = (typeof PROVIDER_SURFACES)[number];

export const PROVIDER_SURFACE_LABELS: Record<ProviderSurface, string> = {
  'shipping.rates': 'Shipping rates',
  'shipping.labels': 'Shipping labels',
  tax: 'Tax',
  address: 'Address validation',
};

export type ConfigField = {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
  /** Overrides the kind's validation, for structured `json` fields. */
  schema?: z.ZodType;
  /** A `provider` field's surface. */
  surface?: ProviderSurface;
};

export type NodeSpec = {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  /** lucide-react icon name. */
  icon: string;
  fields: ConfigField[];
  /** Output branches. A function when they depend on config (the AI router's routes). */
  outputs: string[] | ((config: Record<string, unknown>) => string[]);
  /** Has a saga compensation registered on its step (released on failure). */
  rollback?: boolean;
  /** Waits for a human or an external event. */
  waits?: boolean;
  /** `control.loop` only: has the extra "next" input for back-edges. */
  loop?: boolean;
  retries?: number;
  /** Errors that span fields, after each field passes its own schema. */
  validate?: (config: Record<string, unknown>) => string[];
};

const OUT = ['out'];

const node = (spec: NodeSpec) => spec;

/** The field that picks who does a node's work; installed providers come from the registry. */
const providerField = (surface: ProviderSurface): ConfigField => ({
  key: 'provider',
  label: 'Provider',
  kind: 'provider',
  surface,
  default: 'builtin',
  hint: `Built in, or an installed plugin that provides ${PROVIDER_SURFACE_LABELS[surface].toLowerCase()}`,
});

export const NODE_SPECS = [
  // ── Triggers ────────────────────────────────────────────────────────────────
  node({
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Manual / API',
    description: 'Started from the dashboard or POST /api/v1/orders.',
    icon: 'Play',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'trigger.webhook',
    category: 'trigger',
    label: 'Webhook',
    description:
      'Started by a signed inbound order (POST /api/v1/webhooks/orders) from a storefront, marketplace, POS or other channel.',
    icon: 'Webhook',
    fields: [{ key: 'source', label: 'Source', kind: 'text', default: 'storefront' }],
    outputs: OUT,
  }),
  node({
    type: 'trigger.email_po',
    category: 'trigger',
    label: 'Inbound email',
    description:
      'An order, order form or purchase order arrives by email or upload; the document is stored in R2.',
    icon: 'Mail',
    fields: [{ key: 'mailbox', label: 'Mailbox', kind: 'text', default: 'orders@' }],
    outputs: OUT,
  }),
  node({
    type: 'trigger.schedule',
    category: 'trigger',
    label: 'Schedule',
    description: 'Started on a cadence (reorder runs, subscription renewals).',
    icon: 'CalendarClock',
    fields: [{ key: 'cron', label: 'Cron', kind: 'text', default: '0 6 * * *' }],
    outputs: OUT,
  }),
  node({
    type: 'trigger.inventory_threshold',
    category: 'trigger',
    label: 'Inventory threshold',
    description: 'Started when a SKU falls below its reorder point.',
    icon: 'PackageMinus',
    fields: [],
    outputs: OUT,
  }),

  // ── Commerce ────────────────────────────────────────────────────────────────
  node({
    type: 'commerce.validate',
    category: 'commerce',
    label: 'Validate order',
    description: 'Normalises lines, resolves SKUs and the customer, rejects empty orders.',
    icon: 'ListChecks',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'commerce.price',
    category: 'commerce',
    label: 'Price lines',
    description:
      'Prices each line through the pricing chain (price books, contract prices, volume tiers, then list price) and computes the subtotal.',
    icon: 'Tags',
    fields: [
      {
        key: 'useContracts',
        label: 'Contract pricing',
        kind: 'boolean',
        default: true,
        hint: 'Use negotiated prices when the customer has any',
      },
      {
        key: 'usePriceRules',
        label: 'Price books and volume tiers',
        kind: 'boolean',
        default: true,
        hint: 'Use the price-book and volume entries on the Commerce page',
      },
      {
        key: 'basis',
        label: 'Price basis',
        kind: 'select',
        options: ['auto', 'chain', 'cost'],
        default: 'auto',
        hint: 'auto prices buy-side orders at cost and sell-side orders through the chain',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.discount',
    category: 'commerce',
    label: 'Apply promotions',
    description:
      'Applies the promotion codes the order carries (from a cart, say): lowers the covered lines’ prices, or makes shipping free, and records each redemption against its limits.',
    icon: 'TicketPercent',
    fields: [
      {
        key: 'stack',
        label: 'Stack codes',
        kind: 'boolean',
        default: false,
        hint: 'Off applies only the code worth the most. Place after Price lines (and after Shipping rate for free shipping), before Calculate tax',
      },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.shipping_rate',
    category: 'commerce',
    label: 'Shipping rate',
    description:
      'Rates the order’s shipping (configured services, or live carrier quotes) and charges the chosen option. Pickup, carry-out and digital-only orders ship free.',
    icon: 'Ship',
    fields: [
      {
        key: 'rates',
        label: 'Rates',
        kind: 'json',
        required: true,
        schema: shippingConfigSchema,
        default: {
          services: [
            {
              id: 'standard',
              title: 'Standard',
              carrier: 'ups',
              base: 6.95,
              perItem: 1,
              minDays: 3,
              maxDays: 5,
            },
            {
              id: 'express',
              title: 'Express',
              carrier: 'fedex',
              base: 19.95,
              perItem: 2,
              minDays: 1,
              maxDays: 2,
            },
          ],
          intlMultiplier: 2.5,
          domesticCountries: ['US'],
          freeThreshold: 500,
        },
        hint: 'services (base + perItem × units + perKg × billable kg, in the base currency), basis (units, weight or dim_weight), dimDivisor, defaultKg, liveCarriers, intlMultiplier, domesticCountries, freeThreshold',
      },
      {
        key: 'select',
        label: 'Option',
        kind: 'select',
        options: [...SHIPPING_SELECTIONS],
        default: 'from_order',
        hint: 'from_order charges order.shippingOption, or the cheapest when the order names none',
      },
      providerField('shipping.rates'),
    ],
    outputs: ['ok', 'unavailable'],
  }),
  node({
    type: 'commerce.tax',
    category: 'commerce',
    label: 'Calculate tax',
    description:
      'Computes tax on the subtotal, and on shipping unless told not to (mock tax engine).',
    icon: 'Percent',
    fields: [
      { key: 'rate', label: 'Rate', kind: 'number', default: 0.08 },
      {
        key: 'regions',
        label: 'Rates by region',
        kind: 'json',
        schema: taxRegionsSchema,
        default: [],
        hint: 'Rates for ship-to countries or regions ([{ "country": "US", "region": "CA", "rate": 0.0725 }]), the most specific match first; Rate applies elsewhere',
      },
      {
        key: 'includeShipping',
        label: 'Tax shipping',
        kind: 'boolean',
        default: true,
        hint: 'Off taxes the subtotal only',
      },
      providerField('tax'),
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.policy',
    category: 'commerce',
    label: 'Policy check',
    description:
      'Checks order rules: minimum or maximum total, per-SKU limits, business hours, PO boxes, restricted SKUs.',
    icon: 'Scale',
    fields: [
      {
        key: 'rules',
        label: 'Rules',
        kind: 'json',
        required: true,
        schema: policyRulesSchema.min(1),
        default: [
          { rule: 'min_order_amount', amount: 25 },
          { rule: 'max_qty_per_sku', qty: 500 },
        ],
        hint: 'min_order_amount, max_order_amount, max_qty_per_sku, business_hours, no_po_box, restricted_skus',
      },
    ],
    outputs: ['pass', 'fail'],
  }),
  node({
    type: 'commerce.address_validate',
    category: 'commerce',
    label: 'Validate address',
    description:
      'Checks and normalises the ship-to in order.meta.shipTo. A correction is offered in vars.suggestedAddress.',
    icon: 'MapPin',
    fields: [providerField('address')],
    outputs: ['valid', 'corrected', 'invalid'],
  }),
  node({
    type: 'commerce.credit_check',
    category: 'commerce',
    label: 'Credit check',
    description:
      'Compares the order total plus open balance with the customer’s credit limit. Guests and consumers have no credit account.',
    icon: 'ShieldCheck',
    fields: [
      {
        key: 'noAccount',
        label: 'Without a credit account',
        kind: 'select',
        options: ['over_limit', 'ok'],
        default: 'over_limit',
        hint: 'Where orders from guests and customers without credit go',
      },
    ],
    outputs: ['ok', 'over_limit'],
  }),
  node({
    type: 'commerce.budget_check',
    category: 'commerce',
    label: 'Budget check',
    description: 'Checks a purchase request against the department budget.',
    icon: 'Wallet',
    fields: [{ key: 'budget', label: 'Budget', kind: 'number', default: 25000 }],
    outputs: ['within', 'over'],
  }),
  node({
    type: 'commerce.reserve_inventory',
    category: 'commerce',
    label: 'Reserve inventory',
    description: 'Holds stock for every line. Released automatically if the order later fails.',
    icon: 'PackageCheck',
    fields: [{ key: 'allowBackorder', label: 'Allow backorder', kind: 'boolean', default: false }],
    outputs: ['ok', 'backorder'],
    rollback: true,
  }),
  node({
    type: 'commerce.authorize_payment',
    category: 'commerce',
    label: 'Authorize payment',
    description:
      'Places an authorization hold for the order total, or checks the card and saves it for later charges. A hold is voided automatically if the order later fails.',
    icon: 'CreditCard',
    fields: [
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        options: ['card', 'card_present', 'wallet', 'gift_card', 'cash', 'ach', 'terms'],
        default: 'card',
      },
      {
        key: 'purpose',
        label: 'Purpose',
        kind: 'select',
        options: ['hold', 'verify'],
        default: 'hold',
        hint: 'hold keeps the money for a later capture; verify checks the card, saves it for Charge, and releases the hold at once',
      },
    ],
    outputs: ['ok', 'declined'],
    rollback: true,
  }),
  node({
    type: 'commerce.split_by_seller',
    category: 'commerce',
    label: 'Split by seller',
    description:
      'Splits the order into one part per marketplace seller. Sellers that auto-accept, and the operator’s own lines, are accepted at once; the rest wait for the seller.',
    icon: 'Store',
    fields: [],
    outputs: ['accepted', 'awaiting'],
    rollback: true,
  }),
  node({
    type: 'commerce.seller_accept',
    category: 'commerce',
    label: 'Seller response',
    description:
      'Records a seller’s accept or reject from a seller.responded event, or rejects every seller still pending. Once none is pending, a partial acceptance drops the rejected sellers’ lines.',
    icon: 'Handshake',
    fields: [
      {
        key: 'decision',
        label: 'Decision',
        kind: 'select',
        options: ['from_event', 'expire_pending'],
        default: 'from_event',
        hint: 'from_event reads vars.seller_responded { sellerId, decision, reason? }',
      },
    ],
    outputs: ['accepted', 'partial', 'rejected', 'pending'],
  }),
  node({
    type: 'commerce.payout',
    category: 'commerce',
    label: 'Seller payouts',
    description:
      'Schedules a payout to each accepted seller: their lines, less the commission and their share of refunds.',
    icon: 'HandCoins',
    fields: [],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.route_fulfillment',
    category: 'commerce',
    label: 'Route fulfillment',
    description:
      'Decides where the physical lines come from: central stock or a store that ships, the pickup store, or the till’s store for carry-out. Digital lines also take the digital branch, so a mixed cart takes two.',
    icon: 'Route',
    fields: [
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        options: ['from_order', 'ship', 'pickup', 'carry_out'],
        default: 'from_order',
        hint: 'from_order uses order.fulfillment.method, or ship',
      },
    ],
    outputs: ['ship', 'pickup', 'carry_out', 'digital', 'unavailable'],
  }),
  node({
    type: 'commerce.pickup_ready',
    category: 'commerce',
    label: 'Ready for pickup',
    description: 'Stages the held stock at the pickup store and issues a pickup code.',
    icon: 'ShoppingBag',
    fields: [],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.handover',
    category: 'commerce',
    label: 'Hand over',
    description:
      'The customer has the goods: a pickup is collected or a carry-out sale leaves the store, and held stock is consumed. Returns go through the return steps.',
    icon: 'HandPlatter',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'commerce.deliver_digital',
    category: 'commerce',
    label: 'Deliver digital goods',
    description:
      'Issues a code (licence key, download or gift card) per unit of each digital line.',
    icon: 'KeyRound',
    fields: [],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.capture_payment',
    category: 'commerce',
    label: 'Capture payment',
    description:
      'Captures a previous authorization, up to the order total; anything left on the authorization is released.',
    icon: 'BadgeDollarSign',
    fields: [],
    outputs: ['ok', 'failed'],
  }),
  node({
    type: 'commerce.charge',
    category: 'commerce',
    label: 'Charge',
    description: 'Charges the stored payment method (subscription renewal).',
    icon: 'Repeat',
    fields: [],
    outputs: ['ok', 'failed'],
    retries: 0,
  }),
  node({
    type: 'commerce.refund',
    category: 'commerce',
    label: 'Refund',
    description:
      'Refunds captured or charged money, all of it or an amount computed from the context.',
    icon: 'Undo2',
    fields: [
      {
        key: 'amount',
        label: 'Amount (expression)',
        kind: 'logic',
        hint: 'Empty refunds everything still refundable',
      },
      { key: 'reason', label: 'Reason', kind: 'text', default: 'Customer return' },
    ],
    outputs: ['ok', 'failed'],
  }),
  node({
    type: 'commerce.invoice',
    category: 'commerce',
    label: 'Generate invoice',
    description:
      'Renders the invoice to R2 with the configured payment terms, and can also issue it through Stripe for the customer to pay online. Unpaid invoices for business customers go on their account, and come off it if the order fails (a Stripe invoice is voided).',
    icon: 'FileText',
    fields: [
      {
        key: 'provider',
        label: 'Issue through',
        kind: 'select',
        options: ['document', 'stripe'],
        default: 'document',
        hint: 'stripe also finalizes a Stripe invoice the customer pays online; its payment delivers payment.received',
      },
      {
        key: 'sendEmail',
        label: 'Email the invoice',
        kind: 'boolean',
        default: true,
        hint: 'stripe only: Stripe emails the invoice to the customer',
      },
      {
        key: 'terms',
        label: 'Terms',
        kind: 'select',
        options: ['due_on_receipt', 'net_15', 'net_30', 'net_60'],
        default: 'due_on_receipt',
      },
      {
        key: 'onAccount',
        label: 'Bill to account',
        kind: 'boolean',
        default: true,
        hint: 'Add unpaid business invoices to the customer’s balance',
      },
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.generate_po',
    category: 'commerce',
    label: 'Generate PO',
    description: 'Renders a purchase order for the supplier to R2.',
    icon: 'FilePlus2',
    fields: [{ key: 'supplier', label: 'Supplier', kind: 'text', default: '{{vars.supplier}}' }],
    outputs: OUT,
  }),
  node({
    type: 'commerce.ship',
    category: 'commerce',
    label: 'Create shipment',
    description: 'Buys a label and books the carrier. Cancelled automatically if the order fails.',
    icon: 'Truck',
    fields: [
      {
        key: 'carrier',
        label: 'Carrier',
        kind: 'select',
        options: ['from_order', 'ups', 'fedex', 'dhl', 'freight'],
        default: 'ups',
        hint: 'from_order books the carrier of the shipping option the order was charged for',
      },
      providerField('shipping.labels'),
    ],
    outputs: OUT,
    rollback: true,
  }),
  node({
    type: 'commerce.return_label',
    category: 'commerce',
    label: 'Return label',
    description: 'Issues a prepaid return label (an RMA) and sends it to the customer.',
    icon: 'PackageOpen',
    fields: [
      {
        key: 'carrier',
        label: 'Carrier',
        kind: 'select',
        options: ['ups', 'fedex', 'dhl', 'freight'],
        default: 'ups',
      },
      providerField('shipping.labels'),
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.three_way_match',
    category: 'commerce',
    label: '3-way match',
    description: 'Matches the PO, the goods receipt and the supplier invoice.',
    icon: 'GitCompareArrows',
    fields: [{ key: 'tolerance', label: 'Tolerance', kind: 'number', default: 0.02 }],
    outputs: ['match', 'mismatch'],
  }),
  node({
    type: 'commerce.pay_supplier',
    category: 'commerce',
    label: 'Pay supplier',
    description: 'Schedules the supplier payment.',
    icon: 'Landmark',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'commerce.restock',
    category: 'commerce',
    label: 'Restock',
    description: 'Adds received or returned quantities to on-hand inventory.',
    icon: 'Warehouse',
    fields: [
      {
        key: 'lines',
        label: 'Lines (expression)',
        kind: 'logic',
        hint: 'A list of { sku, qty }; empty restocks every order line. Capped at the ordered quantity.',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'commerce.erp_sync',
    category: 'commerce',
    label: 'ERP sync',
    description: 'Posts the order to the ERP (mock).',
    icon: 'DatabaseZap',
    fields: [{ key: 'system', label: 'System', kind: 'text', default: 'netsuite' }],
    outputs: OUT,
  }),
  node({
    type: 'commerce.notify',
    category: 'commerce',
    label: 'Notify',
    description:
      'Sends a message to the customer (or a guest’s contact email), a supplier, the marketplace sellers still to answer (else those who accepted) or the team.',
    icon: 'Send',
    fields: [
      {
        key: 'to',
        label: 'To',
        kind: 'select',
        options: ['customer', 'supplier', 'seller', 'team'],
        default: 'customer',
      },
      { key: 'subject', label: 'Subject', kind: 'text', default: 'Order {{order.id}} update' },
      { key: 'body', label: 'Body', kind: 'textarea', default: '' },
    ],
    outputs: OUT,
  }),

  // ── Control ────────────────────────────────────────────────────────────────
  node({
    type: 'control.condition',
    category: 'control',
    label: 'Condition',
    description: 'Branches on a JSON Logic expression over the run context.',
    icon: 'Split',
    fields: [
      {
        key: 'expression',
        label: 'Expression',
        kind: 'logic',
        required: true,
        default: { '>': [{ var: 'order.total' }, 1000] },
      },
    ],
    outputs: ['true', 'false'],
  }),
  node({
    type: 'control.approval',
    category: 'control',
    label: 'Approval',
    description: 'Waits for a person to approve or reject. Escalates when the timeout passes.',
    icon: 'UserCheck',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', default: 'Approve order {{order.id}}' },
      { key: 'assignee', label: 'Assignee', kind: 'text', default: 'manager' },
      { key: 'timeout', label: 'Escalate after', kind: 'duration', default: '2 days' },
    ],
    outputs: ['approved', 'rejected', 'escalated'],
    waits: true,
  }),
  node({
    type: 'control.wait_event',
    category: 'control',
    label: 'Wait for event',
    description: 'Waits for an external event (payment received, supplier ack, goods received).',
    icon: 'Hourglass',
    fields: [
      { key: 'event', label: 'Event', kind: 'text', required: true, default: 'payment.received' },
      { key: 'timeout', label: 'Timeout', kind: 'duration', default: '30 days' },
    ],
    outputs: ['received', 'timeout'],
    waits: true,
  }),
  node({
    type: 'control.wait',
    category: 'control',
    label: 'Wait',
    description: 'Sleeps for a duration, or until a timestamp computed from the context.',
    icon: 'Timer',
    fields: [
      { key: 'duration', label: 'Duration', kind: 'duration', default: '1 day' },
      {
        key: 'until',
        label: 'Until (expression)',
        kind: 'logic',
        hint: 'Epoch ms; overrides duration',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'control.set',
    category: 'control',
    label: 'Set variables',
    description: 'Assigns run variables from JSON Logic expressions.',
    icon: 'Variable',
    fields: [
      {
        key: 'assign',
        label: 'Assignments',
        kind: 'json',
        default: { cycle: { '+': [{ var: 'vars.cycle' }, 1] } },
        hint: '{ name: expression }',
      },
    ],
    outputs: OUT,
  }),
  node({
    type: 'control.loop',
    category: 'control',
    label: 'Loop',
    description:
      'Repeats its body while the condition holds, up to a limit. Connect the end of the body back to the “next” input.',
    icon: 'IterationCw',
    fields: [
      { key: 'while', label: 'While', kind: 'logic', default: true },
      { key: 'maxIterations', label: 'Max iterations', kind: 'number', default: 12 },
    ],
    outputs: ['body', 'done'],
    loop: true,
  }),
  node({
    type: 'control.continue_as_new',
    category: 'control',
    label: 'Continue as new',
    description:
      'Ends this run and starts a fresh one on the same flow, carrying the variables forward.',
    icon: 'RotateCw',
    fields: [],
    outputs: [],
  }),
  node({
    type: 'control.end',
    category: 'control',
    label: 'End',
    description:
      'Finishes the order. “declined” is a policy or approval no; “failed” rolls back every compensable step.',
    icon: 'CircleStop',
    fields: [
      {
        key: 'outcome',
        label: 'Outcome',
        kind: 'select',
        options: ['completed', 'declined', 'cancelled', 'failed'],
        default: 'completed',
      },
      { key: 'reason', label: 'Reason', kind: 'text', default: '' },
    ],
    outputs: [],
  }),

  // ── AI ─────────────────────────────────────────────────────────────────────
  node({
    type: 'ai.extract',
    category: 'ai',
    label: 'Extract order',
    description:
      'Reads an emailed order, order form or purchase order and extracts the customer, reference and line items.',
    icon: 'ScanText',
    fields: [],
    outputs: OUT,
  }),
  node({
    type: 'ai.classify',
    category: 'ai',
    label: 'Classify',
    description: 'Assigns one label from a list (spend category, urgency, intent).',
    icon: 'Shapes',
    fields: [
      {
        key: 'labels',
        label: 'Labels',
        kind: 'list',
        default: ['it_hardware', 'software', 'office_supplies', 'services', 'travel'],
      },
      { key: 'into', label: 'Store as var', kind: 'text', default: 'category' },
    ],
    outputs: OUT,
  }),
  node({
    type: 'ai.risk_score',
    category: 'ai',
    label: 'Risk score',
    description: 'Scores fraud and credit risk from 0 to 100; branches above the threshold.',
    icon: 'ShieldAlert',
    fields: [{ key: 'threshold', label: 'High risk at', kind: 'number', default: 70 }],
    outputs: ['low', 'high'],
  }),
  node({
    type: 'ai.forecast',
    category: 'ai',
    label: 'Demand forecast',
    description: 'Suggests reorder quantities for SKUs at or below their reorder point.',
    icon: 'TrendingUp',
    fields: [{ key: 'horizonDays', label: 'Horizon (days)', kind: 'number', default: 30 }],
    outputs: OUT,
  }),
  node({
    type: 'ai.summarize',
    category: 'ai',
    label: 'Summarize',
    description: 'Writes a short summary of the order so far into a variable.',
    icon: 'NotebookPen',
    fields: [{ key: 'into', label: 'Store as var', kind: 'text', default: 'summary' }],
    outputs: OUT,
  }),
  node({
    type: 'ai.router',
    category: 'ai',
    label: 'Agent router',
    description:
      'An LLM reads the order and context, then chooses exactly one route. Each route is an output.',
    icon: 'Bot',
    fields: [
      {
        key: 'instructions',
        label: 'Instructions',
        kind: 'textarea',
        default: 'Decide how to handle this order.',
      },
      {
        key: 'routes',
        label: 'Routes',
        kind: 'list',
        default: ['auto_approve', 'needs_approval', 'ask_customer'],
      },
    ],
    outputs: (config) => stringList(config.routes, ['auto_approve', 'needs_approval']),
  }),
  node({
    type: 'ai.assess',
    category: 'ai',
    label: 'Assess',
    description:
      'A multimodal decision model reads the order (and any images) and returns a probability for every option of every question. Branches on one question.',
    icon: 'Gauge',
    fields: [
      {
        key: 'questions',
        label: 'Questions',
        kind: 'json',
        hint: 'Question id → { type: noul | choice | score, instructions, criteria }. 1 to 64.',
        schema: assessQuestionsSchema,
        default: {
          route: {
            type: 'choice',
            instructions: 'How should this order be handled?',
            criteria: {
              auto_approve: 'Routine order from a known customer, nothing unusual',
              needs_approval: 'Large, unusual or risky; a person should review it',
              ask_customer: 'Missing or ambiguous details the customer must clarify',
            },
          },
          urgent: { type: 'noul', instructions: 'Is this order time-sensitive?' },
          damage: {
            type: 'score',
            instructions: 'If photos are attached, how damaged is the item?',
            criteria: ['No damage', 'Cosmetic', 'Functional', 'Destroyed'],
          },
        },
      },
      {
        key: 'branchOn',
        label: 'Branch on',
        kind: 'text',
        hint: 'A yes/no or choice question id. Empty: one output.',
        default: 'route',
      },
      {
        key: 'minConfidence',
        label: 'Unsure below',
        kind: 'number',
        hint: 'Confidence 0–1. Above 0 adds an “unsure” output.',
        default: 0,
      },
      {
        key: 'state',
        label: 'State',
        kind: 'select',
        options: ['order', 'order_and_context'],
        default: 'order_and_context',
      },
      {
        key: 'images',
        label: 'Images',
        kind: 'list',
        hint: 'Up to 4: R2 keys, https or data URLs, or {{paths}} to them (e.g. {{order.meta.photos}}).',
        schema: z.array(z.string()),
        default: [],
      },
      { key: 'into', label: 'Store as var', kind: 'text', default: 'assessment' },
    ],
    outputs: (config) => assessOutputs(config.questions, config.branchOn, config.minConfidence),
    validate: assessConfigErrors,
  }),
] as const satisfies readonly NodeSpec[];

export type NodeType = (typeof NODE_SPECS)[number]['type'];

const BY_TYPE = new Map<string, NodeSpec>(NODE_SPECS.map((s) => [s.type, s]));

/**
 * The plugin a node's `provider` field names, and for what; null when the node does its own work
 * (no provider field, or `builtin`).
 */
export function nodeProvider(
  spec: NodeSpec | undefined,
  config: Record<string, unknown> | undefined,
): { plugin: string; surface: ProviderSurface } | null {
  const f = spec?.fields.find((x) => x.kind === 'provider');
  const v = config?.provider;
  if (!f?.surface || typeof v !== 'string' || !v || v === 'builtin') return null;
  return { plugin: v, surface: f.surface };
}

export function nodeSpec(type: string): NodeSpec | undefined {
  return BY_TYPE.get(type);
}

export function nodeOutputs(type: string, config: Record<string, unknown> = {}): string[] {
  const spec = BY_TYPE.get(type);
  if (!spec) return [];
  return typeof spec.outputs === 'function' ? spec.outputs(config) : spec.outputs;
}

/** Config with every missing field filled from its default. */
export function withDefaults(type: string, config: Record<string, unknown> = {}) {
  return specDefaults(BY_TYPE.get(type), config);
}

/** `withDefaults` for a spec in hand (a plugin's, which isn't in the built-in catalog). */
export function specDefaults(spec: NodeSpec | undefined, config: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const f of spec?.fields ?? []) {
    if (f.default !== undefined) out[f.key] = structuredClone(f.default);
  }
  return { ...out, ...config };
}

function fieldSchema(f: ConfigField): z.ZodType {
  if (f.schema) return f.schema;
  switch (f.kind) {
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum((f.options ?? []) as [string, ...string[]]);
    case 'duration':
      return z.string().regex(DURATION_RE, 'Use e.g. "30 seconds", "2 days"');
    case 'list':
      return z.array(z.string().min(1)).min(1);
    case 'logic':
    case 'json':
      return z.unknown();
    default:
      return z.string();
  }
}

/** Validates one node's config against its catalog fields. Returns error messages. */
export function validateConfig(type: string, config: Record<string, unknown>): string[] {
  const spec = BY_TYPE.get(type);
  if (!spec) return [`Unknown node type “${type}”`];
  return validateFields(spec, withDefaults(type, config));
}

/** Checks config (defaults already filled in) against a spec's fields, then its own `validate`. */
export function validateFields(spec: NodeSpec, merged: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of spec.fields) {
    const v = merged[f.key];
    if (v === undefined || v === '') {
      if (f.required) errors.push(`${f.label} is required`);
      continue;
    }
    const r = fieldSchema(f).safeParse(v);
    if (!r.success) errors.push(`${f.label}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  }
  if (!errors.length && spec.validate) errors.push(...spec.validate(merged));
  return errors;
}

export const DURATION_RE = /^\s*(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*$/i;

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** "2 days" → 172800000. Throws on anything else. */
export function durationMs(d: string): number {
  const m = DURATION_RE.exec(d);
  if (!m) throw new Error(`Invalid duration “${d}”`);
  return Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
}

export function stringList(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v)) {
    const xs = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (xs.length) return xs.map((x) => x.trim());
  }
  return fallback;
}
