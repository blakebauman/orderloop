/**
 * Inbound orders: the signed `POST /api/v1/webhooks/orders` that storefronts, marketplaces, POS
 * systems and other channels call to start an order. Kept pure so routing and the payload are unit
 * tested here; the web app does the signature check and the engine call around them.
 */

import { z } from 'zod';
import { fingerprintOf, type StartOrderOnceInput } from './api';
import { orderInputSchema } from './order-schemas';
import { DEFAULT_TEMPLATE } from './templates';
import { ORDER_CHANNELS, type OrderChannel, type OrderModel } from './types';

const shipAddressSchema = z.object({
  name: z.string().max(120).optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  region: z.string().max(100).optional(),
  postalCode: z.string().min(1).max(20),
  country: z.string().min(2).max(60),
  /** Optional; lets route fulfillment ship from the nearest store. */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const inboundOrderSchema = orderInputSchema
  .extend({
    channel: z.enum(ORDER_CHANNELS),
    /** The order's id in the sending system. A repeat of the same channel and id is the same order. */
    externalId: z.string().min(1).max(200),
    /** Run this flow instead of the one routed from model and channel. */
    flowId: z.string().min(1).optional(),
    /** The sending system, for display only, e.g. "shopify". */
    source: z.string().max(60).optional(),
    shipTo: z.union([z.string().min(1).max(500), shipAddressSchema]).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((o) => o.lines.length > 0 || !!o.documentText, {
    message: 'Send at least one line, or documentText for the extract node to read',
    path: ['lines'],
  });
export type InboundOrder = z.infer<typeof inboundOrderSchema>;

/**
 * `ORDER_ROUTES`: a JSON object from `model:channel` (or `model:*`) to a flow id. Anything it
 * doesn't route starts the model's default template.
 */
export function parseOrderRoutes(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(
        Object.entries(v).filter(
          (e): e is [string, string] =>
            /^[a-z0-9_]+:[a-z0-9_*]+$/.test(e[0]) && typeof e[1] === 'string' && e[1] !== '',
        ),
      );
  } catch {
    // fall through to no routes
  }
  return {};
}

/** Built-in routes `ORDER_ROUTES` can override: till sales run the point-of-sale flow. */
export const DEFAULT_ORDER_ROUTES: Record<string, string> = {
  'b2c:pos': 'tpl-pos-sale',
  'd2c:pos': 'tpl-pos-sale',
};

export function flowForOrder(
  model: OrderModel,
  channel: OrderChannel,
  routes: Record<string, string>,
): string {
  const all = { ...DEFAULT_ORDER_ROUTES, ...routes };
  return all[`${model}:${channel}`] ?? all[`${model}:*`] ?? DEFAULT_TEMPLATE[model];
}

export function inboundIdempotencyKey(o: Pick<InboundOrder, 'channel' | 'externalId'>): string {
  return `order:${o.channel}:${o.externalId}`;
}

/**
 * What a retry of an inbound order must match: the sender's payload, not the flow it was routed to,
 * so changing ORDER_ROUTES between a request and its retry still returns the original order.
 */
export function inboundFingerprint(o: InboundOrder): Promise<string> {
  return fingerprintOf(o);
}

export function toStartRequest(o: InboundOrder, flowId: string): StartOrderOnceInput {
  const { flowId: _flowId, source, shipTo, vars, ...input } = o;
  return {
    flowId,
    idempotencyKey: inboundIdempotencyKey(o),
    input: {
      ...input,
      meta: {
        ...input.meta,
        via: 'webhook',
        ...(source ? { source } : {}),
        ...(shipTo ? { shipTo } : {}),
      },
    },
    ...(vars ? { vars } : {}),
  };
}
