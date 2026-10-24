/**
 * OpenAPI 3.1 document for /api/v1, served at GET /api/v1/openapi.json. Request bodies are
 * generated from the same zod schemas the handlers validate with, so they can't drift.
 */

import {
  BASE_CURRENCY,
  inboundOrderSchema,
  ORDER_CHANNELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  OUTBOUND_EVENTS,
  orderInputSchema,
  startOrderSchema,
  ucpSettingsSchema,
} from '@orderloop/core';
import { z } from 'zod';
import {
  cancelInput,
  catalogCategoriesDeleteInput,
  catalogCategoriesInput,
  catalogChannelInput,
  catalogDeleteInput,
  catalogProductsInput,
  catalogTypeInput,
  dataSubjectInput,
  decisionInput,
  eventSchema,
  integrationInput,
  orderEventInput,
  platformInput,
  subscriptionInput,
} from './api-schemas';

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
  '429': ok(
    "Over the caller's requests a minute; wait Retry-After seconds",
    '#/components/schemas/Error',
  ),
};
const orderId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

/** An order as the engine holds it: its input plus the totals the pricing nodes compute. */
function orderSchema() {
  const input = z.toJSONSchema(orderInputSchema, { io: 'output', unrepresentable: 'any' }) as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  const amount = (description: string) => ({ type: 'number', description });
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'integer', description: 'Epoch ms' },
      ...input.properties,
      subtotal: amount('Sum of the priced lines'),
      shipping: amount('Shipping charged by a shipping-rate node; 0 when none ran'),
      tax: amount('Tax on the subtotal, plus shipping when the tax node taxes it'),
      total: amount('subtotal + shipping + tax'),
      taxRate: amount('The rate the tax node applied'),
      taxShipping: { type: 'boolean', description: 'Whether the tax node taxed shipping' },
      fxRate: amount(`Units of the order currency per one ${BASE_CURRENCY}, fixed when priced`),
      baseTotal: amount(`total in ${BASE_CURRENCY}`),
    },
    required: [
      ...new Set([
        'id',
        'createdAt',
        ...(input.required ?? []),
        'subtotal',
        'shipping',
        'tax',
        'total',
      ]),
    ],
  };
}

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
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: { type: 'string' },
              description: 'The `nextCursor` of the previous page; omit for the newest orders.',
            },
          ],
          responses: {
            '200': ok('{ orders, nextCursor }: newest first; nextCursor is null on the last page'),
            ...errors,
          },
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
          requestBody: body(startOrderSchema),
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
          responses: {
            '200': ok('Order state: `status`, `nodes`, `waits`, `vars`, and `order` (an Order)'),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}/events': {
        post: {
          summary: 'Deliver a business event to the node waiting for it',
          parameters: [orderId],
          requestBody: body(orderEventInput),
          responses: {
            '200': ok('{ delivered, nodeId? }; delivered is false when nothing is waiting for it'),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}/approvals/{nodeId}': {
        post: {
          summary: 'Approve or reject an approval node',
          parameters: [
            orderId,
            { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: body(decisionInput),
          responses: {
            '200': ok('Recorded'),
            '403': ok(
              'The caller lacks the approver role, or started this order and the workspace separates approvals',
              '#/components/schemas/Error',
            ),
            '409': ok('That node is not waiting for an approval', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/orders/{id}/cancel': {
        post: {
          summary: 'Cancel an order and release everything it holds',
          parameters: [orderId],
          requestBody: body(cancelInput),
          responses: {
            '200': ok('Cancelled'),
            '409': ok('The order has already finished', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/webhooks/events': {
        post: {
          summary: 'Signed inbound event (no bearer token)',
          description:
            "Sign the raw body with your integration's secret: `X-OrderLoop-Signature: t=<unix seconds>,k=<integration id>,v1=<hex HMAC-SHA256(secret, \"<t>.<body>\")>`. Signatures older than 5 minutes are rejected. `403` when the integration's scope doesn't allow the request.",
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
      '/api/v1/webhooks/stripe': {
        post: {
          summary: 'Stripe webhook (no bearer token)',
          description:
            "Add this URL as a Stripe webhook endpoint and enable `invoice.paid`, `payment_intent.canceled` and `charge.dispute.created`. Verified with `Stripe-Signature` (any `v1` signature from the endpoint's signing secret, within 5 minutes). Each event id is handled once. `invoice.paid` settles an invoice the order issued through Stripe and delivers `payment.received`; `payment_intent.canceled` voids the authorization it held; `charge.dispute.created` delivers `payment.disputed` to a node waiting for it. Other events are acknowledged and ignored.",
          security: [],
          parameters: [
            { name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            ...errors,
            '200': ok('Handled, already handled, or ignored (`{ outcome }`)'),
            '400': ok('Bad signature, or not a Stripe event', '#/components/schemas/Error'),
            '409': ok(
              'The order is not waiting for this payment yet; Stripe delivers it again later',
            ),
            '503': ok('Stripe webhooks are not configured', '#/components/schemas/Error'),
          },
        },
      },
      '/api/v1/channels/shopify/orders': {
        post: {
          summary: 'Shopify orders/create webhook (no bearer token)',
          description:
            'Point a Shopify `orders/create` webhook here. Verified with `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body with SHOPIFY_WEBHOOK_SECRET); other topics are acknowledged and ignored. The order is mapped to an inbound order (channel from `source_name`, model `b2b` when it has a company) and started once per Shopify order id.',
          security: [],
          parameters: [
            {
              name: 'X-Shopify-Hmac-Sha256',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
            { name: 'X-Shopify-Topic', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            ...errors,
            '200': ok(
              'Already received, or a topic other than orders/create (`{ ignored: true }`)',
            ),
            '201': ok('Order started'),
            '400': ok('Not JSON, or a line item without a SKU', '#/components/schemas/Error'),
            '409': ok('The routed flow is not published', '#/components/schemas/Error'),
            '422': ok(
              'This Shopify order was already received with different contents',
              '#/components/schemas/Error',
            ),
            '503': ok('SHOPIFY_WEBHOOK_SECRET is not set', '#/components/schemas/Error'),
          },
        },
      },
      '/api/v1/channels/edi/850': {
        post: {
          summary: 'EDI X12 850 purchase orders (operator)',
          description:
            'A raw X12 interchange of one or more 850 transactions from a trading partner listed in EDI_PARTNERS (ISA sender id → customer). Each PO starts at most once (key `order:edi:<sender>:<PO>`); the response lists the outcome per transaction.',
          requestBody: {
            required: true,
            content: {
              'application/edi-x12': { schema: { type: 'string' } },
              'text/plain': { schema: { type: 'string' } },
            },
          },
          responses: {
            ...errors,
            '200': ok(
              '`{ sender, results: [{ control, poNumber?, status, orderId?, flowId?, replayed?, error? }] }`',
            ),
            '400': ok('Not a valid X12 interchange', '#/components/schemas/Error'),
            '403': ok(
              'The sender is not a configured trading partner, or the caller is not an operator',
              '#/components/schemas/Error',
            ),
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
          summary: 'Audit log, newest first; or with `after`, oldest first for export (admin)',
          description:
            'Sign-ins, failed and throttled sign-ins, setup and recovery, team and token changes, and what was done to orders, approvals, flows and webhooks (through the app, the API, a signed webhook, the assistant, MCP or A2A). Each event carries its place in the hash chain (`seq`, `prevHash`, `hash`). Events are kept 400 days unless your contract sets another period, then archived.',
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
            {
              name: 'after',
              in: 'query',
              description:
                'Only sealed events after this `seq`, oldest first: page forward with the last `seq` you received (0 for the first page)',
              schema: { type: 'integer', minimum: 0 },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
          ],
          responses: { '200': ok('{ events }'), ...errors },
        },
      },
      '/api/v1/audit-events/verify': {
        get: {
          summary: "Check the audit log's hash chain (admin)",
          description:
            "Recomputes each event's hash and checks it follows the one before, up to 2000 events a call. Without `after` it starts at the oldest event still kept; pass `next` from the response as `after` to continue. `ok: false` names the first event that fails (`brokenAt`) and why.",
          parameters: [
            {
              name: 'after',
              in: 'query',
              description: 'Start just after this `seq`',
              schema: { type: 'integer', minimum: 1 },
            },
          ],
          responses: { '200': ok('{ ok, checked, last?, next?, brokenAt?, reason? }'), ...errors },
        },
      },
      '/api/v1/catalog/products': {
        post: {
          summary: 'Write catalog products, up to 500 (operator)',
          description:
            "Validated against each product's type; an unchanged product writes nothing. Each result is `created`, `updated`, `unchanged` or `rejected` (with `issues`). Published documents follow within a minute; `urgent` purges cached copies sooner (purges are rationed, so keep it for takedowns and corrections).",
          requestBody: body(catalogProductsInput),
          responses: { '200': ok('{ results: [{ key, status, version?, issues? }] }'), ...errors },
        },
      },
      '/api/v1/catalog/products/{key}': {
        get: {
          summary: 'A stored catalog product',
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('{ product }'), ...errors },
        },
      },
      '/api/v1/catalog/products/delete': {
        post: {
          summary: 'Delete catalog products (operator)',
          requestBody: body(catalogDeleteInput),
          responses: { '200': ok('{ results }'), ...errors },
        },
      },
      '/api/v1/catalog/aliases/{alias}': {
        get: {
          summary: 'The product holding a SKU, GTIN or slug (`sku:ABC`, `gtin:…`, `slug:en:…`)',
          parameters: [{ name: 'alias', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('{ key }'), ...errors },
        },
      },
      '/api/v1/catalog/types': {
        get: {
          summary: 'Product types, latest version of each',
          responses: { '200': ok('{ types }'), ...errors },
        },
        post: {
          summary: 'Add a product type, or its next version (operator)',
          description:
            'A new type starts at version 1. A new version may only add: attributes, enum values, or relax `required` and deprecate. Anything else is refused with 409 and the reasons.',
          requestBody: body(catalogTypeInput),
          responses: {
            '201': ok('{ type }'),
            '409': ok('The change would break stored products', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/types/{code}': {
        delete: {
          summary: 'Delete a product type, every version (operator)',
          description:
            'Refused with 409 while any product uses the type: delete or move them first.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok('{ ok, code, versions }'),
            '409': ok('Products use it', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/channels/{code}': {
        delete: {
          summary: 'Delete a channel and take down everything it published (admin)',
          description:
            'Removes the channel and unpublishes its product documents, SKU and slug lookups, listing cards, category listings, search entries and category trees. Products keep their data for the channel, so adding it again and reindexing brings it back.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('{ ok, code, unpublished }'), ...errors },
        },
      },
      '/api/v1/catalog/categories/delete': {
        post: {
          summary: 'Delete categories (operator)',
          description:
            'Refused with 409 while a category has children not being deleted with it, or has products filed in it.',
          requestBody: body(catalogCategoriesDeleteInput),
          responses: {
            '200': ok('{ ok, deleted }'),
            '409': ok('Still in use', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/catalog/channels': {
        get: { summary: 'Catalog channels', responses: { '200': ok('{ channels }'), ...errors } },
        post: {
          summary: 'Add or change a channel (operator)',
          description:
            'A changed currency or locale list reaches published documents on the next reindex.',
          requestBody: body(catalogChannelInput),
          responses: { '200': ok('{ channel }'), ...errors },
        },
      },
      '/api/v1/catalog/categories': {
        get: {
          summary: 'Catalog categories',
          responses: { '200': ok('{ categories }'), ...errors },
        },
        post: {
          summary: 'Add or change categories (operator)',
          requestBody: body(catalogCategoriesInput),
          responses: { '200': ok('{ categories }'), ...errors },
        },
      },
      '/api/v1/catalog/feeds': {
        get: {
          summary: 'Recent catalog feeds, newest first',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          ],
          responses: { '200': ok('{ feeds }'), ...errors },
        },
        post: {
          summary: 'Import a feed file (operator)',
          description:
            'The request body is the file, streamed to the catalog: CSV (one row per variant) or NDJSON (one product per line). Answers 202 at once; poll the feed for its counts and the first rejected rows.',
          parameters: [
            {
              name: 'format',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['csv', 'ndjson'] },
            },
            { name: 'name', in: 'query', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'text/csv': { schema: { type: 'string' } },
              'application/x-ndjson': { schema: { type: 'string' } },
            },
          },
          responses: { '202': ok('{ feed }'), ...errors },
        },
      },
      '/api/v1/catalog/feeds/{id}': {
        get: {
          summary: "A feed's progress and result",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok('{ feed }'), ...errors },
        },
      },
      '/api/v1/catalog/reindex': {
        post: {
          summary: 'Republish every product (admin)',
          description:
            'After a channel or document change. Answers with how many products were queued.',
          responses: { '202': ok('{ queued }'), ...errors },
        },
      },
      '/api/v1/data-subjects/export': {
        post: {
          summary: 'Export everything held about a person, by email (admin)',
          description:
            'Their customer accounts, their orders (as a customer, as a guest buyer, or as the sender of an order email) with contact details, lines and metadata, the messages sent to them, their intake log entries and the documents on their orders. Up to 500 orders; `truncated` says when there were more. `teamMember` says the address also belongs to a person on your team.',
          requestBody: body(dataSubjectInput),
          responses: {
            '200': ok(
              'A JSON file: { email, customers, orders, messages, inboundEmails, documents, truncated, teamMember }',
            ),
            ...errors,
          },
        },
      },
      '/api/v1/data-subjects/erase': {
        post: {
          summary: 'Erase a person from orders, accounts, documents and messages (admin)',
          description:
            'Removes who the person is and keeps the commercial record: their contact details, names, addresses, inbound documents and emails, and the messages sent to them go; lines, amounts, payments and shipments stay, and their customer accounts become "Erased customer". Works through 100 orders a call: repeat while `done` is false. Refused with 409 while any of their orders is still running. The audit log keeps its events under its own retention and names the request by a hash of the address.',
          requestBody: body(dataSubjectInput),
          responses: {
            '200': ok(
              '{ ok, done, orders, customers, documents, messages, inboundEmails, teamMember }',
            ),
            '409': ok('{ reason: "active_orders", orders }'),
            ...errors,
          },
        },
      },
      '/api/v1/webhook-subscriptions': {
        get: {
          summary: 'List webhook subscriptions (admin)',
          responses: { '200': ok('Subscriptions'), ...errors },
        },
        post: {
          summary: 'Subscribe a URL to order events (admin)',
          description: 'The response carries the signing secret. It is shown only once.',
          requestBody: body(subscriptionInput),
          responses: { '201': ok('{ subscription, secret }'), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions/{id}': {
        delete: {
          summary: 'Delete a subscription (admin)',
          parameters: [orderId],
          responses: { '200': ok('Deleted'), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions/{id}/rotate': {
        post: {
          summary: 'Rotate a subscription signing secret (admin)',
          description:
            'Returns a new secret, shown once. For 24 hours each delivery carries a signature from the previous secret as well, so the receiver can switch without rejecting any.',
          parameters: [orderId],
          responses: { '200': ok('{ subscription, secret }'), ...errors },
        },
      },
      '/api/v1/webhook-subscriptions/{id}/deliveries': {
        get: {
          summary: 'Recent deliveries, newest first (admin)',
          parameters: [orderId],
          responses: { '200': ok('Deliveries'), ...errors },
        },
      },
      '/api/v1/integrations': {
        get: {
          summary: 'List integrations, the signing keys for external systems (admin)',
          responses: { '200': ok('Integrations, without their secrets'), ...errors },
        },
        post: {
          summary: 'Create an integration (admin)',
          description:
            'The scope says what its signed webhooks may do: `events` it may deliver, whether it may `startOrders`, the `flows` an order may name and the one `channel` it may reach. The response carries the signing secret. It is shown only once.',
          requestBody: body(integrationInput),
          responses: { '201': ok('{ integration, secret }'), ...errors },
        },
      },
      '/api/v1/integrations/{id}/rotate': {
        post: {
          summary: 'Rotate an integration secret (admin)',
          description:
            'Returns a new secret, shown once. The previous secret keeps working for 24 hours, so the sender can switch without a gap.',
          parameters: [orderId],
          responses: { '200': ok('{ integration, secret }'), ...errors },
        },
      },
      '/api/v1/integrations/{id}': {
        delete: {
          summary: 'Revoke an integration (admin)',
          description: 'Both its secrets stop working at once.',
          parameters: [orderId],
          responses: { '200': ok('Revoked'), ...errors },
        },
      },
      '/api/v1/ucp': {
        get: {
          summary: 'Agentic checkout: its settings and the AI shopping platforms let in (admin)',
          responses: { '200': ok('{ settings, platforms }, without their keys'), ...errors },
        },
      },
      '/api/v1/ucp/settings': {
        post: {
          summary: 'Set agentic checkout up, or turn it off (admin)',
          description:
            'The checkout flow is the published flow a completed checkout starts; it must authorize a card payment. `links` are the legal links every checkout shows, and `orderUrl` (with `{id}`) is where a buyer sees their order. A null `checkoutFlowId` turns agentic checkout off.',
          requestBody: body(ucpSettingsSchema),
          responses: {
            '200': ok('{ settings }'),
            '422': ok('The flow cannot take checkouts', '#/components/schemas/Error'),
            ...errors,
          },
        },
      },
      '/api/v1/ucp/platforms': {
        post: {
          summary: 'Let in an AI shopping platform (admin)',
          description:
            'The platform calls with the returned API key and names `profileUrl` in its `UCP-Agent` header. The key is shown only once.',
          requestBody: body(platformInput),
          responses: { '201': ok('{ platform, key }'), ...errors },
        },
      },
      '/api/v1/ucp/platforms/{id}': {
        delete: {
          summary: 'Revoke an AI shopping platform (admin)',
          description: 'Its key stops working at once, and its orders stop sending it events.',
          parameters: [orderId],
          responses: { '200': ok('Revoked'), ...errors },
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
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API token (`ol_live_…`, created on the Team page)',
        },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        Order: orderSchema(),
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
                '`order` summary with its totals (`subtotal`, `shipping`, `tax`, `total`); `node` for node events; `outcome` and `reason` for order.completed / cancelled / failed.',
            },
          },
          required: ['id', 'event', 'occurredAt', 'orderId', 'data'],
        },
      },
    },
  };
}
