/**
 * OpenAPI 3.1 document for /api/v1, served at GET /api/v1/openapi.json. Request bodies are
 * generated from the same zod schemas the handlers validate with, so they can't drift.
 */

import {
  inboundOrderSchema,
  ORDER_CHANNELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  OUTBOUND_EVENTS,
} from '@orderloop/core';
import { z } from 'zod';
import { eventSchema, startSchema, subscriptionInput } from './api-schemas';

import { AUDIT_GROUPS } from './audit';

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
const body = (s: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: schema(s) } },
});
const ok = (description: string, ref?: string) => ({
  description,
  ...(ref ? { content: { 'application/json': { schema: { $ref: ref } } } } : {}),
});
const errors = {
  '400': ok('Invalid request', '#/components/schemas/Error'),
  '401': ok('Missing or wrong bearer token', '#/components/schemas/Error'),
  '404': ok('Not found', '#/components/schemas/Error'),
};
const orderId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

export function openApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OrderLoop API',
      version: '1',
      description:
        'Start orders on a published flow, resume them with events and approvals, and subscribe to signed order events.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    paths: {
      '/api/v1/flows': {
        get: { summary: 'List flows', responses: { '200': ok('Flows'), ...errors } },
      },
      '/api/v1/orders': {
        get: {
          summary: 'List orders',
          parameters: [
            { name: 'model', in: 'query', schema: { type: 'string', enum: [...ORDER_MODELS] } },
            { name: 'channel', in: 'query', schema: { type: 'string', enum: [...ORDER_CHANNELS] } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: [...ORDER_STATUSES] } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': ok('Orders'), ...errors },
        },
        post: {
          summary: 'Start an order',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              schema: { type: 'string', maxLength: 255 },
              description:
                'A repeat with the same key and body returns 200 and the order it created; a different body under the same key returns 422.',
            },
          ],
          requestBody: body(startSchema),
          responses: {
            '201': ok('Started', '#/components/schemas/StartOrderResult'),
            '200': ok(
              'Replayed: the key already created this order',
              '#/components/schemas/StartOrderResult',
            ),
            '422': ok(
              'The Idempotency-Key was already used with a different request',
              '#/components/schemas/Error',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}': {
        get: {
          summary: 'Live order state from its agent',
          parameters: [orderId],
          responses: { '200': ok('Order state'), ...errors },
        },
      },
      '/api/v1/orders/{id}/events': {
        post: {
          summary: 'Deliver a business event to the node waiting for it',
          parameters: [orderId],
          requestBody: body(eventSchema.omit({ orderId: true })),
          responses: { '200': ok('{ delivered, nodeId? }'), ...errors },
        },
      },
      '/api/v1/orders/{id}/approvals/{nodeId}': {
        post: {
          summary: 'Approve or reject an approval node',
          parameters: [
            orderId,
            { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: body(
            z.object({
              decision: z.enum(['approved', 'rejected']),
              by: z.string().optional(),
              note: z.string().optional(),
            }),
          ),
          responses: { '200': ok('Recorded'), ...errors },
        },
      },
      '/api/v1/orders/{id}/cancel': {
        post: {
          summary: 'Cancel an order and release everything it holds',
          parameters: [orderId],
          requestBody: body(z.object({ reason: z.string().optional() })),
          responses: { '200': ok('Cancelled'), ...errors },
        },
      },
      '/api/v1/webhooks/events': {
        post: {
          summary: 'Signed inbound event (no bearer token)',
          description:
            'Sign the raw body: `X-OrderLoop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(WEBHOOK_SECRET, "<t>.<body>")>`. Signatures older than 5 minutes are rejected.',
          security: [],
          parameters: [
            {
              name: 'X-OrderLoop-Signature',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: body(eventSchema),
          responses: {
            '200': ok('Delivered'),
            '409': ok('No node is waiting for this event yet; retry later'),
            ...errors,
          },
        },
      },
      '/api/v1/webhooks/orders': {
        post: {
          summary: 'Signed inbound order (no bearer token)',
          description:
            'Starts an order from a storefront, marketplace, POS or other channel, signed like `/api/v1/webhooks/events`. The flow is `flowId`, else the `ORDER_ROUTES` entry for `model:channel` or `model:*`, else the model’s default template. Channel and `externalId` identify the order: a repeat returns it, and the same pair with a different body is refused.',
          security: [],
          parameters: [
            {
              name: 'X-OrderLoop-Signature',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: body(inboundOrderSchema),
          responses: {
            '200': ok('Already received; the existing order'),
            '201': ok('Order started'),
            '409': ok('The routed flow is not published'),
            '422': ok('This channel and externalId were already received with different contents'),
            ...errors,
          },
        },
      },
      '/api/v1/audit-events': {
        get: {
          summary: 'Security audit log, newest first (operator)',
          description:
            'Sign-ins, failed and throttled sign-ins, team and token changes, and refused shared-password API attempts. Kept 180 days.',
          parameters: [
            {
              name: 'type',
              in: 'query',
              schema: { type: 'string', enum: Object.keys(AUDIT_GROUPS) },
            },
            {
              name: 'before',
              in: 'query',
              description: 'Only events before this time (ms since the epoch), to page back',
              schema: { type: 'integer' },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
          ],
          responses: { '200': ok('{ events }'), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions': {
        get: {
          summary: 'List webhook subscriptions',
          responses: { '200': ok('Subscriptions'), ...errors },
        },
        post: {
          summary: 'Subscribe a URL to order events',
          description: 'The response carries the signing secret. It is shown only once.',
          requestBody: body(subscriptionInput),
          responses: { '201': ok('{ subscription, secret }'), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions/{id}': {
        delete: {
          summary: 'Delete a subscription',
          parameters: [orderId],
          responses: { '200': ok('Deleted'), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions/{id}/deliveries': {
        get: {
          summary: 'Recent deliveries, newest first',
          parameters: [orderId],
          responses: { '200': ok('Deliveries'), ...errors },
        },
      },
    },
    webhooks: Object.fromEntries(
      OUTBOUND_EVENTS.map((event) => [
        event,
        {
          post: {
            summary: event,
            description:
              'Signed with the subscription secret (`X-OrderLoop-Signature`, same scheme as inbound). `X-OrderLoop-Delivery` is stable across retries; dedupe on it.',
            requestBody: {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/OrderEvent' } },
              },
            },
            responses: { '2XX': { description: 'Accepted; any other status is retried' } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'APP_PASSWORD' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        StartOrderResult: {
          type: 'object',
          properties: { orderId: { type: 'string' }, replayed: { type: 'boolean' } },
          required: ['orderId'],
        },
        OrderEvent: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Delivery id' },
            event: { type: 'string', enum: [...OUTBOUND_EVENTS] },
            occurredAt: { type: 'integer', description: 'Epoch ms' },
            orderId: { type: 'string' },
            data: {
              type: 'object',
              description:
                '`order` totals; `node` for node events; `outcome` and `reason` for order.completed / cancelled / failed.',
            },
          },
          required: ['id', 'event', 'occurredAt', 'orderId', 'data'],
        },
      },
    },
  };
}
