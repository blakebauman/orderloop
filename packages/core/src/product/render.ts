/**
 * Published documents. The publisher renders each product once per channel and locale, so a read
 * never merges translations, resolves enum labels or picks a price: the edge streams the stored
 * bytes. The same pass extracts what the listing and search indexes need. Pure.
 */
import type { AttributeDef, Channel, Json, Money, Product, ProductType } from './model';
import { NUMERIC_KINDS, TERM_KINDS } from './model';
import { compileType, pickLocale } from './validate';

export type Option = { code: string; label: string };

export type PublishedVariant = {
  sku: string;
  gtin?: string;
  status: string;
  options: Record<string, Option>;
  attributes: Record<string, Json>;
  price?: Money;
  media?: { src: string; alt?: string; width?: number; height?: number }[];
};

export type ProductDoc = {
  key: string;
  type: string;
  version: number;
  updatedAt: number;
  title: string;
  slug?: string;
  description?: string;
  brand?: string;
  categories: string[];
  primaryCategory?: string;
  media: { src: string; alt?: string; width?: number; height?: number; focus?: [number, number] }[];
  attributes: Record<string, Json>;
  variants: PublishedVariant[];
  price?: Money;
  compareAt?: Money;
  priceRange?: { min: Money; max: Money };
  extra?: Record<string, Json>;
};

/** What a listing shows per product: a few hundred bytes. */
export type ProductCard = {
  key: string;
  version: number;
  title: string;
  slug?: string;
  brand?: string;
  image?: { src: string; alt?: string; width?: number; height?: number };
  price?: Money;
  compareAt?: Money;
  priceRange?: { min: Money; max: Money };
  variants: number;
  attributes: Record<string, Json>;
};

/** What the listing index stores per product in one channel. */
export type IndexEntry = {
  key: string;
  /** The product's permanent numeric id (see `productUid`). */
  uid: number;
  version: number;
  categories: string[];
  /** Term facets: attribute code (and `brand`) → values. */
  terms: Record<string, string[]>;
  /** Numeric facets and sorts: attribute code (and `price`) → values across variants. */
  numbers: Record<string, number[]>;
  /** Milliseconds; the "newest" sort. */
  createdAt: number;
};

/** What a search shard indexes per product, channel and locale. */
export type SearchEntry = {
  key: string;
  version: number;
  title: string;
  brand: string;
  skus: string;
  body: string;
};

export type Rendered = {
  channel: string;
  locale: string;
  doc: string;
  card: string;
  search: SearchEntry;
};

export type Publication = {
  /** Null when the product is not visible in the channel (unpublish it there). */
  rendered: Rendered[] | null;
  index: IndexEntry | null;
};

function optionLabel(def: AttributeDef, code: string, locale: string, fallback: string): Option {
  const v = def.values?.find((x) => x.code === code);
  return { code, label: pickLocale(v?.label, locale, fallback) ?? code };
}

function publishValue(
  def: AttributeDef,
  value: unknown,
  locale: string,
  fallback: string,
): unknown {
  if (value === null || value === undefined) return undefined;
  if (def.kind === 'text' && def.localized)
    return pickLocale(value as Record<string, string>, locale, fallback);
  if (def.kind === 'enum') return optionLabel(def, value as string, locale, fallback);
  if (def.kind === 'multi_enum')
    return (value as string[]).map((c) => optionLabel(def, c, locale, fallback));
  return value as Json;
}

/** A numeric reading of a value for range filters and sorts. */
function numeric(def: AttributeDef, value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  switch (def.kind) {
    case 'number':
      return value as number;
    case 'money':
      return (value as Money).amount;
    case 'measure':
      return (value as { value: number }).value;
    case 'date':
      return Date.parse(value as string);
    default:
      return undefined;
  }
}

function terms(def: AttributeDef, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (def.kind === 'multi_enum') return value as string[];
  if (def.kind === 'bool') return [value ? 'true' : 'false'];
  if (def.kind === 'text' && def.localized) return [];
  return [String(value)];
}

function variantPrice(
  p: Product,
  v: Product['variants'][number],
  channel: Channel,
): Money | undefined {
  const own = v.prices?.[channel.code];
  if (own && own.currency === channel.currency) return own;
  const base = p.channels[channel.code]?.price;
  return base && base.currency === channel.currency ? base : undefined;
}

function priceRange(prices: Money[]): { min: Money; max: Money } | undefined {
  if (prices.length < 2) return undefined;
  let min = prices[0] as Money;
  let max = min;
  for (const m of prices) {
    if (m.amount < min.amount) min = m;
    if (m.amount > max.amount) max = m;
  }
  return min.amount === max.amount ? undefined : { min, max };
}

/** Text of searchable attributes in `locale`, for the search index body. */
function searchableText(
  values: Record<string, unknown>,
  defs: Map<string, { def: AttributeDef }>,
  locale: string,
  fallback: string,
): string[] {
  const out: string[] = [];
  for (const [code, value] of Object.entries(values)) {
    const def = defs.get(code)?.def;
    if (!def?.searchable) continue;
    const v = publishValue(def, value, locale, fallback);
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const o of v) out.push((o as Option).label);
    else if (v && typeof v === 'object' && 'label' in v) out.push((v as Option).label);
    else if (typeof v === 'number') out.push(String(v));
  }
  return out;
}

/**
 * Renders `product` for one channel: a doc, card and search entry per locale, and one index entry.
 * A product that isn't active or isn't listed in the channel renders to nothing (unpublish).
 */
export function renderForChannel(
  product: Product,
  type: ProductType,
  channel: Channel,
  ids: { uid: number; createdAt: number },
): Publication {
  const listing = product.channels[channel.code];
  if (product.status !== 'active' || !listing?.visible) return { rendered: null, index: null };
  const c = compileType(type);
  const fallback = channel.defaultLocale;
  const variants = product.variants.filter((v) => v.status === 'active');
  if (!variants.length) return { rendered: null, index: null };

  const prices = variants
    .map((v) => variantPrice(product, v, channel))
    .filter((m) => m !== undefined);
  const price = listing.price?.currency === channel.currency ? listing.price : prices[0];
  const compareAt =
    listing.compareAt?.currency === channel.currency ? listing.compareAt : undefined;
  const range = priceRange(prices);
  const axes = new Set(type.variantAxes);

  // Index entry: locale-independent codes, so one per channel.
  const termValues: Record<string, Set<string>> = {};
  const numberValues: Record<string, number[]> = { price: prices.map((m) => m.amount) };
  if (product.brand) termValues.brand = new Set([product.brand]);
  const collect = (values: Record<string, unknown>, defs: CompiledDefs) => {
    for (const [code, value] of Object.entries(values)) {
      const def = defs.get(code)?.def;
      if (!def?.filterable && !def?.sortable) continue;
      if (TERM_KINDS.includes(def.kind)) {
        let set = termValues[code];
        if (!set) {
          set = new Set();
          termValues[code] = set;
        }
        for (const t of terms(def, value)) set.add(t);
      }
      if (NUMERIC_KINDS.includes(def.kind)) {
        const n = numeric(def, value);
        if (n !== undefined && Number.isFinite(n)) {
          const list = numberValues[code] ?? [];
          list.push(n);
          numberValues[code] = list;
        }
      }
    }
  };
  collect(product.attributes, c.product);
  for (const v of variants) collect(v.attributes, c.variant);
  const index: IndexEntry = {
    key: product.key,
    uid: ids.uid,
    version: product.version,
    categories: product.categories,
    terms: Object.fromEntries(Object.entries(termValues).map(([k, s]) => [k, [...s]])),
    numbers: numberValues,
    createdAt: ids.createdAt,
  };

  const rendered: Rendered[] = channel.locales.map((locale) => {
    const attrs = (values: Record<string, unknown>, defs: CompiledDefs, skip?: Set<string>) => {
      const out: Record<string, Json> = {};
      for (const [code, value] of Object.entries(values)) {
        if (skip?.has(code)) continue;
        const def = defs.get(code)?.def;
        if (!def) continue;
        const v = publishValue(def, value, locale, fallback);
        if (v !== undefined) out[code] = v as Json;
      }
      return out;
    };
    const media = product.media.map((m) => ({
      src: m.src,
      alt: pickLocale(m.alt, locale, fallback),
      width: m.width,
      height: m.height,
      focus: m.focus,
    }));
    const title = pickLocale(product.title, locale, fallback) ?? product.key;
    const slug = pickLocale(product.slug, locale, fallback);
    const docVariants: PublishedVariant[] = variants.map((v) => {
      const options: Record<string, Option> = {};
      for (const axis of type.variantAxes) {
        const def = c.variant.get(axis)?.def;
        const code = v.attributes[axis];
        if (def && typeof code === 'string')
          options[axis] = optionLabel(def, code, locale, fallback);
      }
      return {
        sku: v.sku,
        gtin: v.gtin,
        status: v.status,
        options,
        attributes: attrs(v.attributes, c.variant, axes),
        price: variantPrice(product, v, channel),
        media: v.media?.map((m) => ({
          src: m.src,
          alt: pickLocale(m.alt, locale, fallback),
          width: m.width,
          height: m.height,
        })),
      };
    });
    const doc: ProductDoc = {
      key: product.key,
      type: `${product.type}@${product.typeVersion}`,
      version: product.version,
      updatedAt: product.updatedAt,
      title,
      slug,
      description: pickLocale(product.description, locale, fallback),
      brand: product.brand,
      categories: product.categories,
      primaryCategory: product.primaryCategory,
      media,
      attributes: attrs(product.attributes, c.product),
      variants: docVariants,
      price,
      compareAt,
      priceRange: range,
      extra: product.extra,
    };
    const cardAttrs: Record<string, Json> = {};
    for (const [code, value] of Object.entries(doc.attributes))
      if (c.product.get(code)?.def.card) cardAttrs[code] = value;
    const first = media[0];
    const card: ProductCard = {
      key: product.key,
      version: product.version,
      title,
      slug,
      brand: product.brand,
      image: first && { src: first.src, alt: first.alt, width: first.width, height: first.height },
      price,
      compareAt,
      priceRange: range,
      variants: variants.length,
      attributes: cardAttrs,
    };
    const body = [
      pickLocale(product.description, locale, fallback) ?? '',
      ...searchableText(product.attributes, c.product, locale, fallback),
      ...variants.flatMap((v) => searchableText(v.attributes, c.variant, locale, fallback)),
    ].join(' ');
    return {
      channel: channel.code,
      locale,
      doc: JSON.stringify(doc),
      card: JSON.stringify(card),
      search: {
        key: product.key,
        version: product.version,
        title,
        brand: product.brand ?? '',
        skus: variants.map((v) => `${v.sku} ${v.gtin ?? ''}`).join(' '),
        body,
      },
    };
  });
  return { rendered, index };
}

type CompiledDefs = Map<string, { def: AttributeDef }>;
