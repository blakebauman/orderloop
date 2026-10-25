import { describe, expect, it } from 'vitest';
import {
  applyPromotion,
  choosePromotions,
  type OrderLine,
  type Promotion,
  promoCodesOf,
  promotionProblem,
  regionalTaxRate,
  unknownPromotion,
} from '../src';

const promo = (p: Partial<Promotion> = {}): Promotion => ({
  id: 'promo_1',
  code: 'SAVE10',
  name: '',
  kind: 'pct',
  value: 10,
  currency: null,
  minSubtotal: null,
  skus: null,
  customerId: null,
  validFrom: null,
  validTo: null,
  maxRedemptions: null,
  perCustomerLimit: null,
  status: 'active',
  ...p,
});
const lines: OrderLine[] = [
  { sku: 'A', qty: 2, unitPrice: 50 },
  { sku: 'B', qty: 1, unitPrice: 100 },
];
const ctx = {
  now: 1_000,
  customerId: 'cus_1',
  currency: 'USD',
  fxRate: 1,
  lines,
  redeemed: { total: 0, byCustomer: 0 },
};

describe('promotion codes', () => {
  it('reads an order’s codes normalised and once each', () => {
    expect(promoCodesOf({ promoCodes: [' save10 ', 'SAVE10', 'bad code', 3, 'x2'] })).toEqual([
      'SAVE10',
      'X2',
    ]);
    expect(promoCodesOf({})).toEqual([]);
    expect(promoCodesOf(undefined)).toEqual([]);
  });

  it('says why a promotion doesn’t apply', () => {
    expect(promotionProblem(promo(), ctx)).toBeNull();
    expect(promotionProblem(promo({ status: 'paused' }), ctx)).toMatch(/paused/);
    expect(promotionProblem(promo({ validFrom: 2_000 }), ctx)).toMatch(/isn't valid yet/);
    expect(promotionProblem(promo({ validTo: 1_000 }), ctx)).toMatch(/expired/);
    // Another customer's code reads exactly like one that doesn't exist, so codes can't be probed.
    expect(promotionProblem(promo({ customerId: 'cus_2' }), ctx)).toBe(
      unknownPromotion(promo().code),
    );
    // Paused, upcoming or expired, it still reads as unknown: none of that may show it exists.
    for (const over of [
      { status: 'paused' as const },
      { validFrom: ctx.now + 1 },
      { validTo: ctx.now - 1 },
    ])
      expect(promotionProblem(promo({ customerId: 'cus_2', ...over }), ctx)).toBe(
        unknownPromotion(promo().code),
      );
    expect(promotionProblem(promo({ currency: 'EUR' }), ctx)).toMatch(/EUR orders/);
    expect(
      promotionProblem(promo({ maxRedemptions: 1 }), {
        ...ctx,
        redeemed: { total: 1, byCustomer: 0 },
      }),
    ).toMatch(/used up/);
    expect(
      promotionProblem(promo({ perCustomerLimit: 1 }), {
        ...ctx,
        redeemed: { total: 5, byCustomer: 1 },
      }),
    ).toMatch(/already been used/);
    expect(promotionProblem(promo({ skus: ['Z'] }), ctx)).toMatch(/doesn't cover/);
    expect(promotionProblem(promo({ minSubtotal: 201 }), ctx)).toMatch(/at least 201/);
    expect(promotionProblem(promo({ minSubtotal: 200 }), ctx)).toBeNull();
  });
});

describe('applying promotions', () => {
  it('takes a percentage off the covered lines’ prices', () => {
    const r = applyPromotion(promo({ value: 10 }), lines, { fxRate: 1 });
    expect(r.lines.map((l) => l.unitPrice)).toEqual([45, 90]);
    expect(r.amount).toBe(20);
    const onlyB = applyPromotion(promo({ value: 50, skus: ['B'] }), lines, { fxRate: 1 });
    expect(onlyB.lines.map((l) => l.unitPrice)).toEqual([50, 50]);
    expect(onlyB.amount).toBe(50);
  });

  it('spreads an amount over the covered lines, never past their total, in the order’s currency', () => {
    const r = applyPromotion(promo({ kind: 'amount', value: 30 }), lines, { fxRate: 1 });
    expect(r.amount).toBe(30);
    const capped = applyPromotion(promo({ kind: 'amount', value: 500, skus: ['A'] }), lines, {
      fxRate: 1,
    });
    expect(capped.amount).toBe(100);
    expect(capped.lines[0]!.unitPrice).toBe(0);
    // A base-currency amount converts at the order's rate.
    expect(
      applyPromotion(promo({ kind: 'amount', value: 10 }), lines, { fxRate: 0.9 }).amount,
    ).toBe(9);
  });

  it('leaves the lines alone for free shipping', () => {
    expect(applyPromotion(promo({ kind: 'free_shipping' }), lines, { fxRate: 1 })).toEqual({
      lines,
      amount: 0,
    });
  });

  it('applies the one worth the most unless codes stack', () => {
    const ten = promo({ id: 'a', code: 'TEN', value: 10 });
    const ship = promo({ id: 'b', code: 'SHIP', kind: 'free_shipping' });
    const fifty = promo({ id: 'c', code: 'FIFTY', kind: 'amount', value: 50 });
    expect(
      choosePromotions([ten, ship, fifty], lines, { fxRate: 1, shipping: 30, stack: false }),
    ).toEqual([fifty]);
    expect(choosePromotions([ten, ship], lines, { fxRate: 1, shipping: 30, stack: false })).toEqual(
      [ship],
    );
    expect(choosePromotions([ten, ship], lines, { fxRate: 1, shipping: 30, stack: true })).toEqual([
      ten,
      ship,
    ]);
  });
});

describe('tax by region', () => {
  const regions = [
    { country: 'US', region: 'CA', rate: 0.0725 },
    { country: 'US', rate: 0.05 },
    { country: 'CA', rate: 0.13 },
  ];
  it('takes the most specific match, then the fallback', () => {
    expect(regionalTaxRate(regions, 'US', 'ca', 0.08)).toBe(0.0725);
    expect(regionalTaxRate(regions, 'US', 'NY', 0.08)).toBe(0.05);
    expect(regionalTaxRate(regions, 'CA', undefined, 0.08)).toBe(0.13);
    expect(regionalTaxRate(regions, 'DE', undefined, 0.08)).toBe(0.08);
    expect(regionalTaxRate(regions, undefined, undefined, 0.08)).toBe(0.08);
  });
});
