import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  isBuySide,
  ORDER_MODELS,
  orderInputSchema,
  TEMPLATES,
  templatesFor,
} from '../src';

describe('orderInputSchema', () => {
  it('requires a model and defaults the channel', () => {
    expect(orderInputSchema.safeParse({}).success).toBe(false);
    expect(orderInputSchema.parse({ model: 'b2c' })).toMatchObject({
      model: 'b2c',
      channel: 'api',
      currency: 'USD',
      lines: [],
      meta: {},
    });
  });

  it('takes a guest contact, fulfillment and a line seller', () => {
    const input = orderInputSchema.parse({
      model: 'marketplace',
      channel: 'marketplace',
      externalId: 'mkt-1001',
      contact: { email: 'sam@example.com', name: 'Sam' },
      fulfillment: { method: 'pickup', locationId: 'loc_soho' },
      lines: [{ sku: 'HP-200', qty: 1, sellerId: 'sel_brightside' }],
    });
    expect(input.contact?.email).toBe('sam@example.com');
    expect(input.fulfillment?.method).toBe('pickup');
    expect(input.lines[0]?.sellerId).toBe('sel_brightside');
    expect(
      orderInputSchema.safeParse({ model: 'b2c', contact: { email: 'not-an-email' } }).success,
    ).toBe(false);
    expect(orderInputSchema.safeParse({ model: 'b2c', channel: 'fax' }).success).toBe(false);
  });
});

describe('models', () => {
  it('prices buy-side models at cost', () => {
    expect(ORDER_MODELS.filter(isBuySide)).toEqual(['procurement', 'replenishment']);
  });

  it('starts every model from a template', () => {
    for (const model of ORDER_MODELS)
      expect(TEMPLATES[DEFAULT_TEMPLATE[model]]).toBeTypeOf('function');
    expect(templatesFor('b2b').map((f) => f.id)).toEqual(['tpl-b2b-order']);
    for (const [id, build] of Object.entries(TEMPLATES)) {
      const flow = build();
      expect(flow.id).toBe(id);
      expect(flow.channels.length).toBeGreaterThan(0);
    }
  });
});
