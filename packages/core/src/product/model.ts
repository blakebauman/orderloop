/**
 * The product catalog's object model. A product's shape is fixed in a few typed fields; everything
 * else is an attribute declared by its product type. Types change by adding a version, never by
 * editing one, so a stored product always validates against the version it names. Pure.
 */
import { z } from 'zod';

import { CODE, LOCALE } from './paths';

export { DOC_FORMAT } from './paths';

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const ATTRIBUTE_KINDS = [
  'text',
  'number',
  'bool',
  'enum',
  'multi_enum',
  'money',
  'measure',
  'date',
  'ref',
  'json',
] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** Kinds a listing can filter and count as terms. */
export const TERM_KINDS: readonly AttributeKind[] = ['enum', 'multi_enum', 'bool', 'text', 'ref'];
/** Kinds a listing can filter by range and sort. */
export const NUMERIC_KINDS: readonly AttributeKind[] = ['number', 'money', 'measure', 'date'];

export const codeSchema = z.string().regex(CODE, 'letters, digits, ".", "_" or "-" (max 128)');
export const localeSchema = z.string().regex(LOCALE);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

/** An amount in integer minor units (cents; whole units for zero-decimal currencies). */
export const moneySchema = z.object({
  amount: z.number().int().safe(),
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;

/** A value per locale; publishing falls back to the channel's default locale. */
export const localizedSchema = z.record(localeSchema, z.string().max(10_000));
export type Localized = z.infer<typeof localizedSchema>;

export const attributeDefSchema = z.object({
  code: codeSchema,
  label: localizedSchema.optional(),
  kind: z.enum(ATTRIBUTE_KINDS),
  /** Where the value lives: on the product, or on each variant. */
  scope: z.enum(['product', 'variant']).default('product'),
  /** Text only: one value per locale. */
  localized: z.boolean().default(false),
  required: z.boolean().default(false),
  /** Indexed for listing filters and facet counts. */
  filterable: z.boolean().default(false),
  /** Indexed for keyword search. */
  searchable: z.boolean().default(false),
  /** Offered as a listing sort (numeric kinds only). */
  sortable: z.boolean().default(false),
  /** Shown on listing cards. */
  card: z.boolean().default(false),
  /** Allowed values for enum and multi_enum, in display order. */
  values: z
    .array(z.object({ code: codeSchema, label: localizedSchema.optional() }))
    .max(5_000)
    .optional(),
  /** measure only: the unit stored values are normalized to. */
  unit: z.string().max(16).optional(),
  /** Range facet bucket edges for numeric kinds, ascending. */
  buckets: z.array(z.number()).max(50).optional(),
  /** Superseded: still accepted and published, no longer offered for new data. */
  deprecated: z.boolean().default(false),
});
export type AttributeDef = z.infer<typeof attributeDefSchema>;
export type AttributeDefInput = z.input<typeof attributeDefSchema>;

export const productTypeSchema = z
  .object({
    code: codeSchema,
    version: z.number().int().positive(),
    label: localizedSchema.optional(),
    attributes: z.array(attributeDefSchema).max(500),
    /** Variant-scoped enum attributes that tell variants apart (size, color). */
    variantAxes: z.array(codeSchema).max(5).default([]),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const a of t.attributes) {
      if (seen.has(a.code))
        ctx.addIssue({ code: 'custom', message: `duplicate attribute ${a.code}` });
      seen.add(a.code);
      if ((a.kind === 'enum' || a.kind === 'multi_enum') && !a.values?.length)
        ctx.addIssue({ code: 'custom', message: `${a.code}: ${a.kind} needs values` });
      if (a.localized && a.kind !== 'text')
        ctx.addIssue({ code: 'custom', message: `${a.code}: only text can be localized` });
      if (a.sortable && !NUMERIC_KINDS.includes(a.kind))
        ctx.addIssue({ code: 'custom', message: `${a.code}: only numeric kinds sort` });
      if (a.filterable && a.kind === 'json')
        ctx.addIssue({ code: 'custom', message: `${a.code}: json can't be filtered` });
    }
    for (const axis of t.variantAxes) {
      const a = t.attributes.find((x) => x.code === axis);
      if (a?.scope !== 'variant' || a.kind !== 'enum')
        ctx.addIssue({ code: 'custom', message: `axis ${axis} must be a variant enum attribute` });
    }
  });
export type ProductType = z.infer<typeof productTypeSchema>;
export type ProductTypeInput = z.input<typeof productTypeSchema>;

/**
 * A new version may only add attributes, add enum values, relax `required`, or mark attributes
 * deprecated. Anything else would make stored products invalid or change what a published filter
 * means. Returns the problems; empty means the change is allowed.
 */
export function typeChangeIssues(prev: ProductType, next: ProductType): string[] {
  const issues: string[] = [];
  if (next.code !== prev.code) issues.push('code changed');
  if (next.version !== prev.version + 1) issues.push(`version must be ${prev.version + 1}`);
  const byCode = new Map(next.attributes.map((a) => [a.code, a]));
  for (const p of prev.attributes) {
    const n = byCode.get(p.code);
    if (!n) {
      issues.push(`${p.code} removed (deprecate it instead)`);
      continue;
    }
    if (n.kind !== p.kind) issues.push(`${p.code} kind changed`);
    if (n.scope !== p.scope) issues.push(`${p.code} scope changed`);
    if (n.localized !== p.localized) issues.push(`${p.code} localized changed`);
    if (n.required && !p.required) issues.push(`${p.code} became required`);
    if (n.unit !== p.unit) issues.push(`${p.code} unit changed`);
    const nextValues = new Set(n.values?.map((v) => v.code));
    for (const v of p.values ?? [])
      if (!nextValues.has(v.code)) issues.push(`${p.code} value ${v.code} removed`);
  }
  for (const n of next.attributes)
    if (n.required && !prev.attributes.some((p) => p.code === n.code))
      issues.push(`${n.code} added as required`);
  if (next.variantAxes.join() !== prev.variantAxes.join()) issues.push('variant axes changed');
  return issues;
}

export const channelSchema = z.object({
  code: codeSchema,
  name: z.string().max(200),
  currency: currencySchema,
  locales: z.array(localeSchema).min(1).max(50),
  /** The locale missing translations fall back to; one of `locales`. */
  defaultLocale: localeSchema,
});
export type Channel = z.infer<typeof channelSchema>;

export const mediaSchema = z.object({
  /** R2 key or absolute https URL. */
  src: z.string().max(1024),
  alt: localizedSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Focal point, 0..1 from the top left. */
  focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});
export type Media = z.infer<typeof mediaSchema>;

/** Any JSON value. Typed as JSON (not `unknown`) so products cross RPC with their real type. */
export const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;

/** Attribute values as written. Their shape is checked against the product type. */
export const attributeValuesSchema = z.record(codeSchema, jsonSchema);

/**
 * Whether `digits` is a GTIN-8, -12 (UPC), -13 (EAN) or -14 with a correct GS1 check digit: from
 * the right, the digits before the check digit weigh 3, 1, 3, 1…, and the check digit brings the
 * sum to a multiple of 10.
 */
export function isGtin(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * A GTIN as 14 digits (zero-padded on the left), so a UPC and the same item's EAN or GTIN-14 are
 * one identifier; null when it isn't a valid GTIN.
 */
export function gtin14(digits: string): string | null {
  return isGtin(digits) ? digits.padStart(14, '0') : null;
}

export const variantInputSchema = z.object({
  sku: codeSchema,
  status: z.enum(PRODUCT_STATUSES).default('active'),
  /** As written (8, 12, 13 or 14 digits); claimed and matched as its GTIN-14 (`gtin14`). */
  gtin: z.string().refine(isGtin, 'a GTIN-8, -12, -13 or -14 with a valid check digit').optional(),
  /** The manufacturer's part number: unique only within its brand, so searched but not claimed. */
  mpn: z.string().trim().min(1).max(70).optional(),
  attributes: attributeValuesSchema.default({}),
  /** Overrides the product's price in a channel. */
  prices: z.record(codeSchema, moneySchema).optional(),
  media: z.array(mediaSchema).max(20).optional(),
  /** One unit's shipping weight in kilograms, for Order Loop's weight-based shipping rates. */
  weightKg: z.number().positive().max(100_000).optional(),
  /** One unit's packed size in centimetres, for dimensional-weight shipping rates. */
  dimensionsCm: z
    .object({
      length: z.number().positive().max(10_000),
      width: z.number().positive().max(10_000),
      height: z.number().positive().max(10_000),
    })
    .optional(),
});
export type VariantInput = z.input<typeof variantInputSchema>;
export type Variant = z.infer<typeof variantInputSchema>;

export const channelListingSchema = z.object({
  visible: z.boolean().default(true),
  price: moneySchema.optional(),
  /** The "was" price, shown struck through. */
  compareAt: moneySchema.optional(),
});
export type ChannelListing = z.infer<typeof channelListingSchema>;

/** Hard caps that keep a product a few kilobytes: big values belong in media or R2. */
export const LIMITS = {
  variants: 250,
  categories: 50,
  media: 50,
  /** Serialized bytes of the `extra` bag, which is stored and published but never indexed. */
  extraBytes: 16_384,
  /** Serialized bytes of a whole product. */
  productBytes: 262_144,
} as const;

export const productInputSchema = z.object({
  key: codeSchema,
  /** `code` or `code@version`; without a version, the latest is used and recorded. */
  type: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(@\d+)?$/),
  status: z.enum(PRODUCT_STATUSES).default('active'),
  title: localizedSchema,
  slug: localizedSchema.optional(),
  description: localizedSchema.optional(),
  brand: z.string().max(200).optional(),
  categories: z.array(codeSchema).max(LIMITS.categories).default([]),
  /** Breadcrumb category; defaults to the first of `categories`. */
  primaryCategory: codeSchema.optional(),
  media: z.array(mediaSchema).max(LIMITS.media).default([]),
  attributes: attributeValuesSchema.default({}),
  variants: z.array(variantInputSchema).min(1).max(LIMITS.variants),
  channels: z.record(codeSchema, channelListingSchema).default({}),
  /** Unvalidated, unindexed passthrough data. */
  extra: z.record(z.string(), jsonSchema).optional(),
});
export type ProductInput = z.input<typeof productInputSchema>;
/** A product after defaults are applied and its type version is pinned. */
export type ProductData = Omit<z.infer<typeof productInputSchema>, 'type'> & {
  type: string;
  typeVersion: number;
};

/** A stored product: its data, plus what the store maintains. */
export type Product = ProductData & {
  /** Increments on every change that alters the content hash. */
  version: number;
  /** Content hash of the data (see `contentHash`); equal hashes mean nothing changed. */
  hash: string;
  updatedAt: number;
};

export const categorySchema = z.object({
  code: codeSchema,
  parent: codeSchema.nullable().default(null),
  name: localizedSchema,
  slug: localizedSchema.optional(),
  position: z.number().int().default(0),
});
export type Category = z.infer<typeof categorySchema>;
export type CategoryInput = z.input<typeof categorySchema>;

/** Splits `code@3` into its parts; a bare code has no version. */
export function parseTypeRef(ref: string): { code: string; version?: number } {
  const at = ref.lastIndexOf('@');
  if (at < 0) return { code: ref };
  return { code: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}
