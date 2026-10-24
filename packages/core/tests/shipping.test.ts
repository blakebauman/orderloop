import { describe, expect, it } from 'vitest';
import {
  billableKg,
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
    // Unit-based unless a flow says otherwise.
    expect(c).toMatchObject({ basis: 'units', dimDivisor: 5000, defaultKg: 1 });
    expect(c.services[0]!.perKg).toBe(0);
    expect(shippingConfigSchema.safeParse({ ...c, basis: 'volume' }).success).toBe(false);
    expect(shippingConfigSchema.safeParse({ ...c, dimDivisor: 0 }).success).toBe(false);
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

describe('billable weight', () => {
  // 40 × 30 × 20 cm is 24,000 cm³: 4.8 kg at 5000 cm³/kg.
  const box = { lengthCm: 40, widthCm: 30, heightCm: 20 };

  it('weighs nothing under the units basis', () => {
    expect(billableKg(config(), [{ qty: 2, weightKg: 3, ...box }])).toBeUndefined();
  });

  it('sums each unit’s weight under the weight basis, ignoring size', () => {
    const c = config({ basis: 'weight' });
    expect(
      billableKg(c, [
        { qty: 2, weightKg: 1.25, ...box },
        { qty: 1, weightKg: 0.4 },
      ]),
    ).toEqual({ kg: 2.9, estimated: 0 });
  });

  it('charges the greater of weight and dimensional weight per unit', () => {
    const c = config({ basis: 'dim_weight' });
    // A light, bulky unit bills its dimensional weight; a dense, small one its actual weight.
    expect(billableKg(c, [{ qty: 2, weightKg: 1, ...box }])).toEqual({ kg: 9.6, estimated: 0 });
    expect(
      billableKg(c, [{ qty: 1, weightKg: 10, lengthCm: 10, widthCm: 10, heightCm: 10 }]),
    ).toEqual({ kg: 10, estimated: 0 });
    // The divisor is the flow's: 6000 makes the same box 4 kg.
    expect(
      billableKg(config({ basis: 'dim_weight', dimDivisor: 6000 }), [{ qty: 1, ...box }]),
    ).toEqual({ kg: 4, estimated: 0 });
  });

  it('uses what it knows, and defaultKg for a unit with neither weight nor size', () => {
    const c = config({ basis: 'dim_weight', defaultKg: 2 });
    expect(
      billableKg(c, [
        { qty: 1, ...box }, // size only: 4.8
        { qty: 1, weightKg: 0.5 }, // weight only: 0.5
        { qty: 3, weightKg: null, lengthCm: 10, widthCm: null, heightCm: 10 }, // partial size: 3 × 2
      ]),
    ).toEqual({ kg: 11.3, estimated: 3 });
    // Under weight, a unit known only by its size is estimated too.
    expect(billableKg(config({ basis: 'weight' }), [{ qty: 2, ...box }])).toEqual({
      kg: 2,
      estimated: 2,
    });
  });

  it('adds perKg × billable kg to a static service, and nothing under units', () => {
    const weighed = config({ basis: 'weight', intlMultiplier: 2 });
    weighed.services[0]!.perKg = 2;
    const req = { itemCount: 1, billableKg: 2.5, subtotal: 10 };
    // standard: 5 + 1 × 1 + 2 × 2.5; services without perKg are unchanged.
    expect(staticRates(weighed, req).map((o) => o.amount)).toEqual([11, 15, 4.5]);
    expect(staticRates(weighed, { ...req, country: 'DE' })[0]!.amount).toBe(22);
    const units = config();
    units.services[0]!.perKg = 2;
    expect(staticRates(units, req)[0]!.amount).toBe(6);
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
