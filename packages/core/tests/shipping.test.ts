import { describe, expect, it } from 'vitest';
import {
  nodeSpec,
  parseCarrierQuote,
  pickOption,
  rateOptions,
  type ShippingConfig,
  shippingConfigSchema,
  shipToCountry,
  staticRates,
  validateConfig,
  withDefaults,
} from '../src';

const config = (c: Record<string, unknown> = {}): ShippingConfig =>
  shippingConfigSchema.parse({
    services: [
      {
        id: 'standard',
        title: 'Standard',
        carrier: 'ups',
        base: 5,
        perItem: 1,
        minDays: 3,
        maxDays: 5,
      },
      { id: 'express', title: 'Express', carrier: 'fedex', base: 15, minDays: 1, maxDays: 2 },
      {
        id: 'economy',
        title: 'Economy',
        carrier: 'usps',
        base: 4,
        perItem: 0.5,
        minDays: 5,
        maxDays: 9,
      },
    ],
    ...c,
  });

describe('shipping config', () => {
  it('fills defaults and upper-cases the domestic countries', () => {
    const c = config({ domesticCountries: ['us', 'ca'] });
    expect(c.intlMultiplier).toBe(1);
    expect(c.liveCarriers).toEqual([]);
    expect(c.domesticCountries).toEqual(['US', 'CA']);
    expect(c.services[1]!.perItem).toBe(0);
  });

  it('rejects live carriers that are not https, and inverted delivery windows', () => {
    const live = (url: string) =>
      shippingConfigSchema.safeParse({
        services: [{ id: 's', title: 'S', carrier: 'ups', base: 1, minDays: 1, maxDays: 2 }],
        liveCarriers: [{ id: 'acme', carrier: 'acme', url }],
      }).success;
    expect(live('https://rates.example/quote')).toBe(true);
    expect(live('http://rates.example/quote')).toBe(false);
    expect(
      shippingConfigSchema.safeParse({
        services: [{ id: 's', title: 'S', carrier: 'ups', base: 1, minDays: 4, maxDays: 2 }],
      }).success,
    ).toBe(false);
    expect(shippingConfigSchema.safeParse({ services: [] }).success).toBe(false);
  });

  it('is the shipping_rate node’s validated config, and the default passes', () => {
    expect(nodeSpec('commerce.shipping_rate')?.outputs).toEqual(['ok', 'unavailable']);
    expect(
      validateConfig('commerce.shipping_rate', withDefaults('commerce.shipping_rate')),
    ).toEqual([]);
    expect(validateConfig('commerce.shipping_rate', { rates: { services: [] } })).toHaveLength(1);
    expect(validateConfig('commerce.shipping_rate', { select: 'slowest' })).toHaveLength(1);
  });
});

describe('static rates', () => {
  it('charges base plus per item, times the multiplier outside domestic countries', () => {
    const c = config({ intlMultiplier: 2 });
    const domestic = staticRates(c, { itemCount: 3, country: 'US', subtotal: 10 });
    expect(domestic.map((o) => [o.id, o.amount])).toEqual([
      ['standard', 8],
      ['express', 15],
      ['economy', 5.5],
    ]);
    const intl = staticRates(c, { itemCount: 3, country: 'de', subtotal: 10 });
    expect(intl.map((o) => o.amount)).toEqual([16, 30, 11]);
    // No country counts as domestic; at least one unit is charged.
    expect(staticRates(c, { itemCount: 0, subtotal: 0 })[0]!.amount).toBe(6);
  });
});

describe('rate options', () => {
  it('sorts cheapest first and frees the cheapest at the threshold', () => {
    const c = config({ freeThreshold: 100 });
    const under = rateOptions(c, { itemCount: 1, subtotal: 99.99 });
    expect(under.map((o) => [o.id, o.amount])).toEqual([
      ['economy', 4.5],
      ['standard', 6],
      ['express', 15],
    ]);
    expect(under.some((o) => o.free)).toBe(false);
    const over = rateOptions(c, { itemCount: 1, subtotal: 100 });
    expect(over[0]).toMatchObject({ id: 'economy', amount: 0, free: true });
    expect(over[1]).toMatchObject({ id: 'standard', amount: 6 });
  });

  it('uses live quotes when any came back, and still applies the threshold', () => {
    const c = config({ freeThreshold: 50 });
    const live = parseCarrierQuote(
      { id: 'acme', carrier: 'acme', url: 'https://rates.example' },
      {
        options: [
          { id: 'ground', title: 'Ground', amount: 7.25, minDays: 2, maxDays: 4 },
          { id: 'air', amount: 22 },
          { id: 'bad', amount: -1 },
          'nonsense',
        ],
      },
    );
    expect(live).toEqual([
      { id: 'acme_ground', title: 'Ground', carrier: 'acme', amount: 7.25, minDays: 2, maxDays: 4 },
      { id: 'acme_air', title: 'air', carrier: 'acme', amount: 22, minDays: 0, maxDays: 0 },
    ]);
    expect(rateOptions(c, { itemCount: 1, subtotal: 10 }, live).map((o) => o.id)).toEqual([
      'acme_ground',
      'acme_air',
    ]);
    expect(rateOptions(c, { itemCount: 1, subtotal: 60 }, live)[0]).toMatchObject({
      id: 'acme_ground',
      amount: 0,
    });
    expect(parseCarrierQuote({ id: 'x', carrier: 'x', url: 'https://x.example' }, null)).toEqual(
      [],
    );
  });
});

describe('pickOption', () => {
  const options = rateOptions(config(), { itemCount: 1, subtotal: 0 });

  it('takes the order’s option, or the cheapest when it names none', () => {
    expect(pickOption(options, 'from_order', 'express')?.id).toBe('express');
    expect(pickOption(options, 'from_order')?.id).toBe('economy');
    expect(pickOption(options, 'from_order', 'teleport')).toBeUndefined();
  });

  it('picks the cheapest or the fastest', () => {
    expect(pickOption(options, 'cheapest', 'express')?.id).toBe('economy');
    expect(pickOption(options, 'fastest')?.id).toBe('express');
    expect(pickOption([], 'cheapest')).toBeUndefined();
  });
});

describe('shipToCountry', () => {
  it('normalises the ship-to country', () => {
    expect(shipToCountry({ meta: { shipTo: { country: 'USA' } } })).toBe('US');
    expect(shipToCountry({ meta: { shipTo: { country: 'de' } } })).toBe('DE');
    expect(shipToCountry({ meta: { shipTo: '1 Main St' } })).toBeUndefined();
    expect(shipToCountry({ meta: {} })).toBeUndefined();
  });
});
