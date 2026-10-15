/**
 * The flow graph (what the editor saves and the Workflow interprets) and the order it runs for.
 * Edge fields use React Flow's names so the canvas can bind them without mapping.
 */

import { z } from 'zod';

/** The commerce model an order belongs to. Buy-side models are orders the business places. */
export const ORDER_MODELS = [
  'b2b',
  'b2c',
  'd2c',
  'marketplace',
  'subscription',
  'procurement',
  'replenishment',
] as const;
export type OrderModel = (typeof ORDER_MODELS)[number];

export const ORDER_MODEL_LABELS: Record<OrderModel, string> = {
  b2b: 'B2B',
  b2c: 'B2C retail',
  d2c: 'Direct to consumer',
  marketplace: 'Marketplace',
  subscription: 'Subscription',
  procurement: 'Procurement',
  replenishment: 'Replenishment',
};

export const BUY_SIDE_MODELS: readonly OrderModel[] = ['procurement', 'replenishment'];

/** Buy-side orders are priced at cost; sell-side orders run the price chain. */
export function isBuySide(model: OrderModel): boolean {
  return BUY_SIDE_MODELS.includes(model);
}

/** Where an order came in. */
export const ORDER_CHANNELS = [
  'web',
  'mobile',
  'pos',
  'marketplace',
  'email',
  'edi',
  'api',
  'manual',
  'schedule',
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_CHANNEL_LABELS: Record<OrderChannel, string> = {
  web: 'Web',
  mobile: 'Mobile app',
  pos: 'Point of sale',
  marketplace: 'Marketplace',
  email: 'Email',
  edi: 'EDI',
  api: 'API',
  manual: 'Dashboard',
  schedule: 'Schedule',
};

export const FULFILLMENT_METHODS = ['ship', 'pickup', 'carry_out', 'digital'] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

export const FULFILLMENT_METHOD_LABELS: Record<FulfillmentMethod, string> = {
  ship: 'Ship',
  pickup: 'Pick up in store',
  carry_out: 'Carry out',
  digital: 'Digital delivery',
};

export const flowNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Node ids are 1–40 letters, digits, _ or -'),
  type: z.string(),
  label: z.string().max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  /** Per-node step retry policy; the catalog supplies a default. */
  retries: z.number().int().min(0).max(10).optional(),
  /** Per-node step timeout, e.g. "30 seconds", "5 minutes". */
  timeout: z.string().optional(),
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /** Output branch of the source, e.g. "true", "approved". Absent means the default "out". */
  sourceHandle: z.string().nullish(),
  /** "next" marks a loop back-edge into a `control.loop` node; anything else is a normal input. */
  targetHandle: z.string().nullish(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

export type Flow = FlowGraph & {
  id: string;
  name: string;
  description: string;
  model: OrderModel;
  /** Channels this flow is meant for. Inbound routing and the UI use it; it does not restrict runs. */
  channels: OrderChannel[];
};

/** A published, immutable flow snapshot. Orders pin one so later edits never change them. */
export type FlowVersion = Flow & { version: number; publishedAt: number };

export const orderLineSchema = z.object({
  sku: z.string(),
  name: z.string().optional(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
  /** Marketplace seller for this line; otherwise the product's seller, or first party. */
  sellerId: z.string().optional(),
  /**
   * The store this line ships from when route fulfillment splits a shipment. Unset lines use
   * `fulfillment.locationId`, or central stock.
   */
  locationId: z.string().optional(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

/** How to reach a buyer who has no customer account (guest checkout, POS receipt). */
export const contactSchema = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
});
export type Contact = z.infer<typeof contactSchema>;

export const fulfillmentSchema = z.object({
  method: z.enum(FULFILLMENT_METHODS),
  /** Store or warehouse to fulfil from, e.g. the pickup store or the till's store. */
  locationId: z.string().optional(),
});
export type Fulfillment = z.infer<typeof fulfillmentSchema>;

export const PAYMENT_PROVIDERS = ['stripe', 'external'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * How the order is paid, when the caller already knows. `stripe` names a PaymentIntent to adopt,
 * a payment method to confirm, or a Stripe customer to charge off-session; `external` means the
 * channel took the money (a Shopify checkout) and `reference` is its id there.
 */
export const orderPaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
  intentId: z
    .string()
    .regex(/^pi_\w+$/)
    .optional(),
  paymentMethodId: z
    .string()
    .regex(/^pm_\w+$/)
    .optional(),
  stripeCustomerId: z
    .string()
    .regex(/^cus_\w+$/)
    .optional(),
  reference: z.string().max(200).optional(),
});
export type OrderPayment = z.infer<typeof orderPaymentSchema>;

export const orderInputSchema = z.object({
  model: z.enum(ORDER_MODELS),
  channel: z.enum(ORDER_CHANNELS).default('api'),
  /** The order's id in the channel it came from (storefront, marketplace, POS). */
  externalId: z.string().max(200).optional(),
  title: z.string().max(140).optional(),
  customerId: z.string().optional(),
  currency: z.string().length(3).default('USD'),
  lines: z.array(orderLineSchema).default([]),
  contact: contactSchema.optional(),
  fulfillment: fulfillmentSchema.optional(),
  /** The shipping option the buyer chose, by id; a shipping-rate node set to `from_order` charges it. */
  shippingOption: z.string().max(80).optional(),
  payment: orderPaymentSchema.optional(),
  /** Free-form inbound document text (an email, order form or PO) for the AI extract node. */
  documentText: z.string().max(50_000).optional(),
  /** R2 key of an uploaded document. */
  documentKey: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type OrderInput = z.infer<typeof orderInputSchema>;
/** What callers send: `channel`, `currency`, `lines` and `meta` have defaults. */
export type OrderInputDraft = z.input<typeof orderInputSchema>;

/** A request to start an order: POST /api/v1/orders, and A2A's place_order skill. */
export const startOrderSchema = z.object({
  flowId: z.string(),
  version: z.number().int().positive().optional(),
  input: orderInputSchema,
  vars: z.record(z.string(), z.unknown()).optional(),
});

/** The currency list prices, contract prices, price rules, credit limits and reports are in. */
export const BASE_CURRENCY = 'USD';

export type Order = OrderInput & {
  id: string;
  createdAt: number;
  subtotal: number;
  /** Shipping charged, set by a shipping-rate node. */
  shipping: number;
  tax: number;
  /** `subtotal + shipping + tax`. */
  total: number;
  /** The rate the tax node applied, kept so a re-total (a seller dropping lines) charges the same. */
  taxRate?: number;
  /** Whether that tax node taxed shipping too. */
  taxShipping?: boolean;
  /** Units of the order's currency per one BASE_CURRENCY, fixed when the order is priced. */
  fxRate?: number;
  /** `total` in BASE_CURRENCY, for credit, budgets and reporting. */
  baseTotal?: number;
};

export const NODE_STATUSES = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'rolled_back',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const ORDER_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  /** Ended by policy or an approval decision ("not approved"), not by a person cancelling. */
  'declined',
  'cancelled',
  'failed',
  'rolled_back',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  'completed',
  'declined',
  'cancelled',
  'failed',
  'rolled_back',
];

/** What a node needs from the outside world while the Workflow waits on it. */
export type PendingWait = {
  nodeId: string;
  /** The Workflow event type `sendEvent` must use to resume this wait. */
  eventType: string;
  kind: 'approval' | 'event';
  title: string;
  /** For event waits, the business event name, e.g. "payment.received". */
  event?: string;
  amount?: number;
  assignee?: string;
  deadline?: number;
  since: number;
};

export type TimelineEntry = {
  at: number;
  nodeId?: string;
  kind: 'node' | 'order' | 'event' | 'approval' | 'ai' | 'rollback' | 'chat';
  message: string;
  data?: unknown;
  /** Dedupe key: a retried step or replayed report with the same key replaces, not appends. */
  key?: string;
};
