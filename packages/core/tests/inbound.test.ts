import { describe, expect, it } from 'vitest';
import {
  flowForOrder,
  inboundIdempotencyKey,
  inboundOrderSchema,
  parseOrderRoutes,
  toStartRequest,
} from '../src';

const order = (o: Record<string, unknown> = {}) =>
  inboundOrderSchema.parse({
    model: 'b2c',
    channel: 'web',
    externalId: 'shop-1001',
    lines: [{ sku: 'MON-27', qty: 1 }],
    ...o,
  });

describe('inbound orders', () => {
  it('needs a channel, an external id and lines or a document', () => {
    expect(
      inboundOrderSchema.safeParse({ model: 'b2c', externalId: 'x', lines: [{ sku: 'A', qty: 1 }] })
        .success,
    ).toBe(false);
    expect(
      inboundOrderSchema.safeParse({ model: 'b2c', channel: 'web', lines: [{ sku: 'A', qty: 1 }] })
        .success,
    ).toBe(false);
    expect(
      inboundOrderSchema.safeParse({ model: 'b2c', channel: 'web', externalId: 'x' }).success,
    ).toBe(false);
    expect(
      inboundOrderSchema.safeParse({
        model: 'b2b',
        channel: 'email',
        externalId: 'x',
        documentText: '50 x WID-100',
      }).success,
    ).toBe(true);
  });

  it('routes an exact model and channel before a wildcard, then the default template', () => {
    const routes = parseOrderRoutes(
      JSON.stringify({ 'b2c:pos': 'pos-sale', 'b2c:*': 'shop', 'bad key': 'x', 'b2b:web': '' }),
    );
    expect(routes).toEqual({ 'b2c:pos': 'pos-sale', 'b2c:*': 'shop' });
    expect(flowForOrder('b2c', 'pos', routes)).toBe('pos-sale');
    expect(flowForOrder('b2c', 'web', routes)).toBe('shop');
    expect(flowForOrder('b2b', 'web', routes)).toBe('tpl-b2b-order');
    expect(flowForOrder('d2c', 'pos', {})).toBe('tpl-pos-sale');
    expect(flowForOrder('d2c', 'web', {})).toBe('tpl-omnichannel-order');
    expect(parseOrderRoutes('not json')).toEqual({});
    expect(parseOrderRoutes(undefined)).toEqual({});
  });

  it('keys the start by channel and external id and keeps ship-to in meta', () => {
    const o = order({
      source: 'shopify',
      shipTo: { line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
      vars: { promo: 'FALL' },
    });
    expect(inboundIdempotencyKey(o)).toBe('order:web:shop-1001');
    const req = toStartRequest(o, 'tpl-storefront-order');
    expect(req).toMatchObject({
      flowId: 'tpl-storefront-order',
      idempotencyKey: 'order:web:shop-1001',
      vars: { promo: 'FALL' },
      input: {
        model: 'b2c',
        channel: 'web',
        externalId: 'shop-1001',
        meta: { via: 'webhook', source: 'shopify', shipTo: { city: 'Austin' } },
      },
    });
    expect(req.input).not.toHaveProperty('shipTo');
    expect(req.input).not.toHaveProperty('source');
  });
});
