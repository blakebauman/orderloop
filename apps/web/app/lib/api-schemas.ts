/** Request bodies for /api/v1. Shared by the handlers and the OpenAPI document. */

import {
  isWebhookUrl,
  MAX_EVENT_PAYLOAD_BYTES,
  ORDER_CHANNELS,
  OUTBOUND_EVENTS,
  payloadFits,
  WEBHOOK_URL_RULE,
} from '@orderloop/core';
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
