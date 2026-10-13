/**
 * The flow graph (what the editor saves and the Workflow interprets) and the order it runs for.
 * Edge fields use React Flow's names so the canvas can bind them without mapping.
 */

import { z } from 'zod';

export const ORDER_TYPES = [
  'purchase_request',
  'b2b_order',
  'reorder',
  'subscription',
  'storefront_order',
] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  purchase_request: 'Purchase request',
  b2b_order: 'B2B order',
  reorder: 'Reorder',
  subscription: 'Subscription',
  storefront_order: 'Storefront order',
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
  orderType: OrderType;
};

/** A published, immutable flow snapshot. Orders pin one so later edits never change them. */
export type FlowVersion = Flow & { version: number; publishedAt: number };

export const orderLineSchema = z.object({
  sku: z.string(),
  name: z.string().optional(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderInputSchema = z.object({
  type: z.enum(ORDER_TYPES),
  title: z.string().max(140).optional(),
  customerId: z.string().optional(),
  currency: z.string().length(3).default('USD'),
  lines: z.array(orderLineSchema).default([]),
  /** Free-form inbound document text (email body, PO) for the AI extract node. */
  documentText: z.string().max(50_000).optional(),
  /** R2 key of an uploaded document. */
  documentKey: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type OrderInput = z.infer<typeof orderInputSchema>;

/** The currency list prices, contract prices, price rules, credit limits and reports are in. */
export const BASE_CURRENCY = 'USD';

export type Order = OrderInput & {
  id: string;
  createdAt: number;
  subtotal: number;
  tax: number;
  total: number;
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
