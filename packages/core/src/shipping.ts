/**
 * Shipping rates for the `commerce.shipping_rate` node, and the order totals every pricing node
 * recomputes. Pure: the engine quotes live carriers (`quoteShipping`) and passes their options in.
 *
 * Rates are configured on the node, so they are pinned with the flow version: a checkout quote and
 * the order's run read the same config. Amounts are in BASE_CURRENCY, like list prices; the engine
 * converts them at the order's rate.
 *
 * A static service costs `base + perItem × units + perKg × billable kg`, times `intlMultiplier` when
 * the ship-to country is not one of `domesticCountries`. `basis` says what the kilograms are:
 * `units` (the default) rates by units alone, `weight` by each unit's weight, and `dim_weight` by
 * each unit's billable weight, the greater of its weight and its volume over `dimDivisor`
 * (`billableKg`). Live carriers are POSTed the cart and answer with options of
 * their own; when none answers, the static services are used. Options come back cheapest first, and
 * once the subtotal reaches `freeThreshold` the cheapest one is free.
 */

import { z } from 'zod';
import { checkAddress } from './address';
import { money, toBase } from './logic';
import type { Order } from './types';

const serviceSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/, 'Service ids are 1–40 letters, digits, _ or -'),
  title: z.string().min(1).max(80),
  carrier: z.string().min(1).max(40),
  base: z.number().nonnegative(),
  perItem: z.number().nonnegative().default(0),
  /** Per kilogram of billable weight; charged only when the basis is `weight` or `dim_weight`. */
  perKg: z.number().nonnegative().default(0),
  minDays: z.number().int().nonnegative(),
  maxDays: z.number().int().nonnegative(),
});

const liveCarrierSchema = z.object({
  /** Prefixes the ids of the options it returns, and names its credential in the engine. */
  id: z.string().regex(/^[\w-]{1,40}$/, 'Carrier ids are 1–40 letters, digits, _ or -'),
  carrier: z.string().min(1).max(40),
  url: z.url({ protocol: /^https$/, error: 'Live carrier URLs must be https URLs' }),
});

export const SHIPPING_BASES = ['units', 'weight', 'dim_weight'] as const;
export type ShippingBasis = (typeof SHIPPING_BASES)[number];

export const shippingConfigSchema = z
  .object({
    services: z.array(serviceSchema).min(1),
    /** What a service's `perKg` and a carrier's `billableKg` are of; `units` weighs nothing. */
    basis: z.enum(SHIPPING_BASES).default('units'),
    /** cm³ per kg for dimensional weight: 5000 is the common carrier divisor for cm and kg. */
    dimDivisor: z.number().positive().default(5000),
    /** The kilograms a unit counts for when its product has neither weight nor dimensions. */
    defaultKg: z.number().nonnegative().default(1),
    liveCarriers: z.array(liveCarrierSchema).default([]),
    intlMultiplier: z.number().positive().default(1),
    /** ISO 3166-1 alpha-2 codes. A ship-to with no country counts as domestic. */
    domesticCountries: z
      .array(z.string().length(2))
      .default(['US'])
      .transform((cs) => cs.map((c) => c.toUpperCase())),
    /** Subtotal at which the cheapest option is free. */
    freeThreshold: z.number().nonnegative().optional(),
  })
  .refine((c) => c.services.every((s) => s.minDays <= s.maxDays), {
    message: 'A service’s minDays must not exceed its maxDays',
  })
  .refine((c) => new Set(c.services.map((s) => s.id)).size === c.services.length, {
    message: 'Service ids must be unique',
  });
export type ShippingConfig = z.infer<typeof shippingConfigSchema>;
export type LiveCarrier = ShippingConfig['liveCarriers'][number];

export type ShippingOption = {
  id: string;
  title: string;
  carrier: string;
  amount: number;
  minDays: number;
  maxDays: number;
  /** Zeroed by the free-shipping threshold. */
  free?: boolean;
};

/**
 * What the rate is for: physical units, where they go and the subtotal, in BASE_CURRENCY.
 * `billableKg` is set only when the basis weighs units (`weight` or `dim_weight`).
 */
export type RateRequest = {
  itemCount: number;
  billableKg?: number;
  country?: string;
  subtotal: number;
};

/** One line's units as the products table describes them: per-unit kg and cm, null when unknown. */
export type ParcelLine = {
  qty: number;
  weightKg?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
};

/**
 * The billable kilograms of `lines` under the config's basis, summed per unit, to the gram. Under
 * `weight` a unit counts its weight; under `dim_weight` the greater of its weight and its
 * dimensional weight (length × width × height / `dimDivisor`), either alone when only one is known.
 * A unit with nothing to go on counts `defaultKg`, and is counted in `estimated`. Under `units`
 * nothing is weighed: undefined.
 */
export function billableKg(
  config: Pick<ShippingConfig, 'basis' | 'dimDivisor' | 'defaultKg'>,
  lines: ParcelLine[],
): { kg: number; estimated: number } | undefined {
  if (config.basis === 'units') return undefined;
  const known = (n: number | null | undefined): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  let kg = 0;
  let estimated = 0;
  for (const l of lines) {
    if (l.qty <= 0) continue;
    const actual = known(l.weightKg) ? l.weightKg : undefined;
    const dim =
      config.basis === 'dim_weight' && known(l.lengthCm) && known(l.widthCm) && known(l.heightCm)
        ? (l.lengthCm * l.widthCm * l.heightCm) / config.dimDivisor
        : undefined;
    const each =
      actual === undefined && dim === undefined
        ? config.defaultKg
        : Math.max(actual ?? 0, dim ?? 0);
    if (actual === undefined && dim === undefined) estimated += l.qty;
    kg += each * l.qty;
  }
  return { kg: Math.round(kg * 1000) / 1000, estimated };
}

export const SHIPPING_SELECTIONS = ['from_order', 'cheapest', 'fastest'] as const;
export type ShippingSelection = (typeof SHIPPING_SELECTIONS)[number];

export function isDomestic(config: Pick<ShippingConfig, 'domesticCountries'>, country?: string) {
  const c = country?.trim().toUpperCase();
  return !c || config.domesticCountries.includes(c);
}

/** The ship-to's country as a two-letter code ("USA" → "US"), from `meta.shipTo`; else undefined. */
export function shipToCountry(order: Pick<Order, 'meta'>): string | undefined {
  const c = checkAddress(order.meta?.shipTo).address?.country;
  return c && /^[A-Z]{2}$/.test(c) ? c : undefined;
}

/**
 * A place tax is charged by: a country, or a region within it. `commerce.tax`'s rates and a tax
 * exemption certificate's coverage both name places this way.
 */
export const taxPlaceSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code'),
  region: z.string().min(1).max(10).optional(),
});
export type TaxPlace = z.infer<typeof taxPlaceSchema>;

/** Tax rates by ship-to place, for `commerce.tax`. */
export const taxRegionsSchema = z
  .array(taxPlaceSchema.extend({ rate: z.number().min(0).max(0.5) }))
  .max(200);
export type TaxRegion = z.infer<typeof taxRegionsSchema>[number];

/**
 * The rate for an order shipped to `country` and `region`: a match on both first, then the
 * country alone, then `fallback`.
 */
export function regionalTaxRate(
  regions: TaxRegion[],
  country: string | undefined,
  region: string | undefined,
  fallback: number,
): number {
  if (!country) return fallback;
  const r = region?.toUpperCase();
  return (
    regions.find((x) => x.country === country && x.region && x.region.toUpperCase() === r)?.rate ??
    regions.find((x) => x.country === country && !x.region)?.rate ??
    fallback
  );
}

/** The configured services' rates for a request, unsorted. */
export function staticRates(config: ShippingConfig, req: RateRequest): ShippingOption[] {
  const multiplier = isDomestic(config, req.country) ? 1 : config.intlMultiplier;
  const units = Math.max(1, req.itemCount);
  const kg = config.basis === 'units' ? 0 : (req.billableKg ?? 0);
  return config.services.map((s) => ({
    id: s.id,
    title: s.title,
    carrier: s.carrier,
    amount: money((s.base + s.perItem * units + s.perKg * kg) * multiplier),
    minDays: s.minDays,
    maxDays: s.maxDays,
  }));
}

const quotedSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(80).optional(),
  carrier: z.string().max(40).optional(),
  amount: z.number().nonnegative(),
  minDays: z.number().int().nonnegative().optional(),
  maxDays: z.number().int().nonnegative().optional(),
});

/**
 * A live carrier's answer, `{ options: [{ id, amount, title?, carrier?, minDays?, maxDays? }] }`,
 * as options whose ids carry the carrier's id. Malformed options are dropped.
 */
export function parseCarrierQuote(carrier: LiveCarrier, body: unknown): ShippingOption[] {
  const list = (body as { options?: unknown } | null)?.options;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const o = quotedSchema.safeParse(raw);
    if (!o.success) return [];
    const minDays = o.data.minDays ?? 0;
    return [
      {
        id: `${carrier.id}_${o.data.id}`,
        title: o.data.title || o.data.id,
        carrier: o.data.carrier || carrier.carrier,
        amount: money(o.data.amount),
        minDays,
        maxDays: Math.max(minDays, o.data.maxDays ?? minDays),
      },
    ];
  });
}

/**
 * The options to offer, cheapest first: the live carriers' quotes when any answered, otherwise the
 * static services. The cheapest is free once the subtotal reaches the threshold.
 */
export function rateOptions(
  config: ShippingConfig,
  req: RateRequest,
  live: ShippingOption[] = [],
): ShippingOption[] {
  const base = live.length ? live : staticRates(config, req);
  const sorted = [...base].sort((a, b) => a.amount - b.amount || a.maxDays - b.maxDays);
  const free = config.freeThreshold !== undefined && req.subtotal >= config.freeThreshold;
  return sorted.map((o, i) => (free && i === 0 ? { ...o, amount: 0, free: true } : o));
}

/**
 * The option a selection picks. `from_order` takes the order's `shippingOption` when it names one
 * on offer (undefined when it names one that isn't) and the cheapest when it names none.
 */
export function pickOption(
  options: ShippingOption[],
  select: ShippingSelection,
  wanted?: string,
): ShippingOption | undefined {
  if (!options.length) return undefined;
  if (select === 'from_order' && wanted) return options.find((o) => o.id === wanted);
  if (select === 'fastest')
    return [...options].sort(
      (a, b) => a.maxDays - b.maxDays || a.minDays - b.minDays || a.amount - b.amount,
    )[0];
  return options[0];
}

/**
 * Subtotal, shipping, tax and total from the order's lines, shipping and tax rate. Tax is
 * `(subtotal + shipping when taxShipping) × taxRate`; an order no tax node has run on has none.
 */
export function computeTotals(
  order: Pick<Order, 'lines' | 'fxRate'> &
    Partial<Pick<Order, 'shipping' | 'taxRate' | 'taxShipping'>>,
): Pick<Order, 'subtotal' | 'shipping' | 'tax' | 'total' | 'baseTotal'> {
  const subtotal = money(order.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));
  const shipping = money(order.shipping ?? 0);
  const taxable = subtotal + (order.taxShipping ? shipping : 0);
  const tax = money(taxable * (order.taxRate ?? 0));
  const total = money(subtotal + shipping + tax);
  return { subtotal, shipping, tax, total, baseTotal: toBase(total, order.fxRate) };
}
