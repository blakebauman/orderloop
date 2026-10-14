/** Request bodies for /api/v1. Shared by the handlers and the OpenAPI document. */

import { OUTBOUND_EVENTS } from '@orderloop/core';
import { z } from 'zod';

export const eventSchema = z.object({
  orderId: z.string().min(1),
  event: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const subscriptionInput = z.object({
  url: z
    .string()
    .url()
    .refine((u) => {
      const { protocol, hostname } = new URL(u);
      return protocol === 'https:' || (protocol === 'http:' && LOCAL_HOSTS.has(hostname));
    }, 'Use an https URL (plain http is allowed only for localhost)'),
  events: z
    .array(z.enum(['*', ...OUTBOUND_EVENTS]))
    .min(1)
    .default(['*']),
});
