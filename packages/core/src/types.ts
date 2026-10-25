/**
 * The flow graph (what the editor saves and the Workflow interprets) and the order it runs for.
 * Edge fields use React Flow's names so the canvas can bind them without mapping.
 */

import type { FlowGraph, OrderInput, OrderInputDraft } from './order-schemas';

// The schemas' inferred types, still importable from here; the schemas live in order-schemas.ts.
export type {
  Contact,
  FlowEdge,
  FlowGraph,
  FlowNode,
  Fulfillment,
  OrderInput,
  OrderInputDraft,
  OrderLine,
  OrderPayment,
} from './order-schemas';

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
  'agent',
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
  manual: 'Entered by hand',
  schedule: 'Schedule',
  agent: 'AI agent',
};

export const FULFILLMENT_METHODS = ['ship', 'pickup', 'carry_out', 'digital'] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

export const FULFILLMENT_METHOD_LABELS: Record<FulfillmentMethod, string> = {
  ship: 'Ship',
  pickup: 'Pick up in store',
  carry_out: 'Carry out',
  digital: 'Digital delivery',
};

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

export const PAYMENT_PROVIDERS = ['stripe', 'external'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * The order without `meta.simulate`, the field that forces a connector failure. The engine drops
 * it at start unless the deployment allows simulated failures (`SIMULATE_FAILURES`).
 */
export function withoutSimulation<T extends Pick<OrderInputDraft, 'meta'>>(input: T): T {
  if (!input.meta || !('simulate' in input.meta)) return input;
  const { simulate: _simulate, ...meta } = input.meta;
  return { ...input, meta };
}

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
