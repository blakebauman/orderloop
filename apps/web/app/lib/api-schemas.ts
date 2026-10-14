/** Request bodies for /api/v1. Shared by the handlers and the OpenAPI document. */

import { isWebhookUrl, OUTBOUND_EVENTS, WEBHOOK_URL_RULE } from '@orderloop/core';
import { z } from 'zod';

export const eventSchema = z.object({
  orderId: z.string().min(1),
  event: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const subscriptionInput = z.object({
  url: z.string().url().refine(isWebhookUrl, WEBHOOK_URL_RULE),
  events: z
    .array(z.enum(['*', ...OUTBOUND_EVENTS]))
    .min(1)
    .default(['*']),
});
