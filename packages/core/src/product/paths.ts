/**
 * Where published things live, and their cache tags: the contract between the catalog's publisher
 * and catalog-edge. Free of zod and the model, so the edge Worker bundles only this. Pure.
 */

/** Bumped when a published document's shape changes; published paths carry it (`f1`). */
export const DOC_FORMAT = 'f1';

/** Keys, codes and SKUs: printable ASCII without separators, so they are safe in paths and tags. */
export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** BCP 47-ish locale tag: en, en-US, zh-Hant-TW. */
export const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** A slug: lowercase words (any script) joined by "-". */
export const SLUG = /^[\p{Ll}\p{Lo}\p{N}]+(-[\p{Ll}\p{Lo}\p{N}]+)*$/u;

/** Products one batch lookup on catalog-edge returns at most. */
export const BATCH_MAX = 100;

/** Published object paths. Every path carries the doc format, so a format change is a new tree. */
export const paths = {
  doc: (fmt: string, channel: string, locale: string, key: string) =>
    `docs/${fmt}/${channel}/${locale}/p/${key}.json`,
  alias: (fmt: string, channel: string, alias: string) =>
    `docs/${fmt}/${channel}/a/${encodeURIComponent(alias)}`,
  categories: (fmt: string, channel: string, locale: string) =>
    `docs/${fmt}/${channel}/${locale}/categories.json`,
  /** One segment of a category's listing index (`listingSegment` picks a product's). */
  listing: (fmt: string, channel: string, category: string, segment: number) =>
    `idx/${fmt}/${channel}/${category}/${segment}.bin`,
  card: (fmt: string, channel: string, locale: string, uid: number) =>
    `c:${fmt}:${channel}:${locale}:${uid.toString(36)}`,
  /** KV: a product key's uid, so cards (keyed by uid) can be looked up by key. */
  uid: (fmt: string, key: string) => `u:${fmt}:${key}`,
} as const;

/** Cache tags. Printable ASCII only: keys and codes already are. */
export const tags = {
  product: (key: string) => `p:${key}`,
  channel: (channel: string) => `ch:${channel}`,
  category: (code: string) => `cat:${code}`,
  categories: 'cats',
} as const;
