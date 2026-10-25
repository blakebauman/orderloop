/**
 * The zod schemas for flows and orders, apart from types.ts so a page that needs only an order
 * status or a label doesn't load zod: these run `z.object(…)` when imported, which a bundler can't
 * drop. Their inferred types are re-exported from `@orderloop/core` as before.
 */

import { z } from 'zod';
import { FULFILLMENT_METHODS, ORDER_CHANNELS, ORDER_MODELS, PAYMENT_PROVIDERS } from './types';

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
