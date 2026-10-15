/**
 * Amounts between Order Loop (decimal units of the order's currency) and payment processors
 * (integer minor units: cents, or whole units for zero-decimal currencies). Pure.
 */

/** ISO 4217 codes Stripe treats as having no minor unit: 1 means one yen, not a hundredth. */
export const ZERO_DECIMAL_CURRENCIES = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
] as const;

const ZERO_DECIMAL = new Set<string>(ZERO_DECIMAL_CURRENCIES);

/** Minor units per one unit of `currency`: 1 for zero-decimal currencies, else 100. */
export function minorUnitFactor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

/** `amount` in `currency` as an integer of minor units: 12.34 USD → 1234, 1200 JPY → 1200. */
export function toMinor(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) throw new RangeError(`Not an amount: ${amount}`);
  return Math.round(amount * minorUnitFactor(currency));
}

/** Minor units back to a decimal amount: 1234 USD → 12.34. */
export function fromMinor(minor: number, currency: string): number {
  const f = minorUnitFactor(currency);
  return Math.round(minor) / f;
}
