/** Request bodies for /api/v1. Shared by the handlers and the OpenAPI document. */

import {
  isWebhookUrl,
  MAX_CART_TITLE,
  MAX_EVENT_PAYLOAD_BYTES,
  ORDER_CHANNELS,
  OUTBOUND_EVENTS,
  payloadFits,
  WEBHOOK_URL_RULE,
} from '@orderloop/core';
import {
  categorySchema,
  channelSchema,
  productInputSchema,
  productTypeSchema,
} from '@orderloop/core/product';
import { z } from 'zod';

const payload = z
  .record(z.string(), z.unknown())
  .refine(payloadFits, `payload must be at most ${MAX_EVENT_PAYLOAD_BYTES} bytes of JSON`)
  .optional();

export const eventSchema = z.object({
  orderId: z.string().min(1).max(100),
  event: z.string().min(1).max(100),
  payload,
});

export const orderEventInput = eventSchema.omit({ orderId: true });

export const decisionInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});

export const cancelInput = z.object({ reason: z.string().max(500).optional() });

/** Holds a submit to the cart version the caller read (`version` in GET /carts/:id, its ETag). */
export const submitCartInput = z.object({ version: z.number().int().positive().optional() });

/** A staff cart: who opens it is the caller, never the body. */
export const createCartInput = z.object({
  title: z.string().trim().min(1).max(MAX_CART_TITLE),
  /** A published flow with a Price lines step; it prices the cart and runs its order. */
  flowId: z.string().min(1).max(100),
  customerId: z.string().min(1).max(100).nullable().optional(),
});

export const subscriptionInput = z.object({
  url: z.string().url().refine(isWebhookUrl, WEBHOOK_URL_RULE),
  events: z
    .array(z.enum(['*', ...OUTBOUND_EVENTS]))
    .min(1)
    .default(['*']),
});

/** An integration's name and scope (`IntegrationScope` in @orderloop/core). */
export const integrationInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Events it may deliver; `"*"` is any. */
  events: z.array(z.string().min(1).max(100)).max(50).default([]),
  startOrders: z.boolean().default(false),
  /** Flows an order body may name; `"*"` is any. */
  flows: z.array(z.string().min(1).max(100)).max(50).default([]),
  channel: z.enum(ORDER_CHANNELS).nullable().optional(),
});

/** A data subject request: the person, by the email address they're known by. */
export const dataSubjectInput = z.object({ email: z.string().trim().email().max(320) });

/** A UCP platform an admin lets in: its name and the profile it must name in UCP-Agent. */
export const platformInput = z.object({
  name: z.string().trim().min(1).max(100),
  profileUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => u.startsWith('https://'), 'The profile must be served over https'),
});

// The product catalog (/api/v1/catalog). Shapes only: the catalog checks products against their
// product types, which the web app doesn't hold.
export const catalogProductsInput = z.object({
  products: z.array(productInputSchema).min(1).max(500),
  /** Purge cached copies now (rationed) instead of within the minute; for takedowns and fixes. */
  urgent: z.boolean().optional(),
});

export const catalogDeleteInput = z.object({
  keys: z.array(z.string().min(1).max(128)).min(1).max(500),
  urgent: z.boolean().optional(),
});

export const catalogCategoriesDeleteInput = z.object({
  codes: z.array(z.string().min(1).max(128)).min(1).max(500),
});

export const catalogCategoriesInput = z.object({
  categories: z.array(categorySchema).min(1).max(500),
});

export { channelSchema as catalogChannelInput, productTypeSchema as catalogTypeInput };
