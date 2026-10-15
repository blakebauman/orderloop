import { describe, expect, it } from 'vitest';
import {
  fromMinor,
  minorUnitFactor,
  orderInputSchema,
  type PaymentSource,
  paymentSource,
  toMinor,
} from '../src';

describe('money in minor units', () => {
  it('uses cents for most currencies and whole units for zero-decimal ones', () => {
    expect(toMinor(12.34, 'USD')).toBe(1234);
    expect(toMinor(0.1 + 0.2, 'EUR')).toBe(30);
    expect(toMinor(19.999, 'usd')).toBe(2000);
    expect(toMinor(1200, 'JPY')).toBe(1200);
    expect(toMinor(1200.4, 'KRW')).toBe(1200);
    expect(minorUnitFactor('jpy')).toBe(1);
    expect(fromMinor(1234, 'USD')).toBe(12.34);
    expect(fromMinor(1200, 'JPY')).toBe(1200);
  });

  it('round-trips amounts with two decimals', () => {
    for (const n of [0, 0.01, 9.99, 1234.56, 99_999.99])
      expect(fromMinor(toMinor(n, 'GBP'), 'GBP')).toBe(n);
  });

  it('refuses a non-number', () => {
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(RangeError);
  });
});

describe('paymentSource', () => {
  const saved = { stripeCustomerId: 'cus_1', paymentMethodId: 'pm_saved' };
  const cases: [string, Parameters<typeof paymentSource>, PaymentSource][] = [
    ['nothing given', [{}], 'none'],
    ['a saved card', [{}, 'card', saved], 'off_session'],
    ['a saved card without a customer', [{}, 'card', { paymentMethodId: 'pm_saved' }], 'none'],
    [
      'a customer on the order and a saved card',
      [
        { payment: { provider: 'stripe', stripeCustomerId: 'cus_2' } },
        'card',
        { paymentMethodId: 'pm_x' },
      ],
      'off_session',
    ],
    [
      'a payment method',
      [{ payment: { provider: 'stripe', paymentMethodId: 'pm_1' } }, 'card', saved],
      'confirm',
    ],
    [
      'an intent, over a payment method',
      [{ payment: { provider: 'stripe', intentId: 'pi_1', paymentMethodId: 'pm_1' } }],
      'adopt',
    ],
    ['the channel took it', [{ payment: { provider: 'external', intentId: 'pi_1' } }], 'external'],
    ['external at the till', [{ payment: { provider: 'external' } }, 'cash'], 'external'],
    ['cash', [{}, 'cash', saved], 'offline'],
    [
      'a terminal at the till',
      [{ payment: { provider: 'stripe', intentId: 'pi_1' } }, 'card_present'],
      'offline',
    ],
    ['terms', [{}, 'terms'], 'offline'],
    [
      'a wallet',
      [{ payment: { provider: 'stripe', paymentMethodId: 'pm_1' } }, 'wallet'],
      'confirm',
    ],
  ];
  it.each(cases)('%s', (_name, args, expected) => {
    expect(paymentSource(...args)).toBe(expected);
  });

  it('validates Stripe ids on the order', () => {
    const base = { model: 'b2c' as const };
    const ok = (payment: unknown) => orderInputSchema.safeParse({ ...base, payment }).success;
    expect(ok({ provider: 'stripe', intentId: 'pi_3Abc' })).toBe(true);
    expect(ok({ provider: 'stripe', intentId: 'ch_1' })).toBe(false);
    expect(ok({ provider: 'paypal' })).toBe(false);
  });
});
