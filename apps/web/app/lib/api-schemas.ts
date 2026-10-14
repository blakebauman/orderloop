/** Request bodies for /api/v1. Shared by the handlers and the OpenAPI document. */

import {
  isWebhookUrl,
  MAX_EVENT_PAYLOAD_BYTES,
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
  by: z.string().max(200).optional(),
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
