import { OUTBOUND_EVENTS } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import { subscriptionInput } from '../app/lib/api-schemas';
import { openApiDocument } from '../app/lib/openapi';

describe('OpenAPI document', () => {
  const doc = openApiDocument('https://orderloop.example');

  it('serialises, and generates every request body from its zod schema', () => {
    const json = JSON.parse(JSON.stringify(doc));
    expect(json.openapi).toBe('3.1.0');
    const start = json.paths['/api/v1/orders'].post.requestBody.content['application/json'].schema;
    expect(start.required).toEqual(expect.arrayContaining(['flowId', 'input']));
    expect(start.properties.input.properties.model.enum).toContain('marketplace');
    expect(start.properties.input.properties.channel.enum).toContain('pos');
    type Op = { requestBody?: { content: Record<string, { schema: unknown }> } };
    for (const [path, item] of Object.entries(json.paths) as [string, Record<string, Op>][])
      for (const op of Object.values(item))
        if (op.requestBody)
          for (const media of Object.values(op.requestBody.content))
            expect(media.schema, path).toHaveProperty('type');
  });

  it('describes an order with its shipping and totals', () => {
    const json = JSON.parse(JSON.stringify(doc));
    const start = json.paths['/api/v1/orders'].post.requestBody.content['application/json'].schema;
    expect(start.properties.input.properties.shippingOption.type).toBe('string');
    const order = json.components.schemas.Order;
    expect(order.required).toEqual(
      expect.arrayContaining(['id', 'subtotal', 'shipping', 'tax', 'total']),
    );
    expect(order.properties.shippingOption.type).toBe('string');
  });

  it('documents every outbound event and leaves signed inbound events unauthenticated', () => {
    expect(Object.keys(doc.webhooks)).toEqual([...OUTBOUND_EVENTS]);
    expect(doc.paths['/api/v1/webhooks/events'].post.security).toEqual([]);
    expect(doc.paths['/api/v1/webhooks/orders'].post.security).toEqual([]);
    // Stripe and Shopify sign with their own headers; EDI comes from an operator token.
    expect(doc.paths['/api/v1/webhooks/stripe'].post.security).toEqual([]);
    expect(Object.keys(doc.paths['/api/v1/webhooks/stripe'].post.responses)).toEqual(
      expect.arrayContaining(['200', '400', '409', '503']),
    );
    expect(doc.paths['/api/v1/channels/shopify/orders'].post.security).toEqual([]);
    expect(doc.paths['/api/v1/channels/edi/850'].post).not.toHaveProperty('security');
  });
});

describe('webhook subscription input', () => {
  it('requires https except on localhost, and defaults to every event', () => {
    expect(subscriptionInput.parse({ url: 'https://hooks.example/x' }).events).toEqual(['*']);
    expect(subscriptionInput.safeParse({ url: 'http://localhost:8788/hook' }).success).toBe(true);
    expect(subscriptionInput.safeParse({ url: 'http://hooks.example/x' }).success).toBe(false);
    expect(
      subscriptionInput.safeParse({ url: 'https://hooks.example/x', events: ['order.lost'] })
        .success,
    ).toBe(false);
  });
});
