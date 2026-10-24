/**
 * The public routes, and the one canonical URL each request is cached under. The gateway parses a
 * request into a Route and forwards only `canonical(route)`: query parameters a route doesn't use
 * are dropped and the ones it does are cleaned, so every way of asking for the same thing hits the
 * same cache entry, and junk never reaches the cache at all.
 *
 *   GET /v1/<channel>/<locale>/products/<key>      a product document
 *   GET /v1/<channel>/<locale>/products?keys=a,b   up to 100 listing cards, in that order
 *   GET /v1/<channel>/<locale>/skus/<sku>          the product holding a SKU
 *   GET /v1/<channel>/<locale>/slugs/<slug>        the product with a slug in that locale
 *   GET /v1/<channel>/<locale>/categories          the category tree
 *   GET /v1/<channel>/<locale>/categories/<code>/products?f.<attr>=a,b&r.<attr>=lo..hi
 *       &sort=<newest|attr_asc|attr_desc>&cursor=<n>&limit=<1-100>
 *                                                  a filtered, faceted, sorted category page
 */
// The zod-free part of core only: this Worker's bundle stays small.
import { BATCH_MAX, CODE, LOCALE, SLUG } from '@orderloop/core/product/paths';

export type Route =
  | { kind: 'product'; channel: string; locale: string; key: string }
  | { kind: 'batch'; channel: string; locale: string; keys: string[] }
  | { kind: 'sku'; channel: string; locale: string; sku: string }
  | { kind: 'slug'; channel: string; locale: string; slug: string }
  | { kind: 'categories'; channel: string; locale: string }
  | {
      kind: 'listing';
      channel: string;
      locale: string;
      category: string;
      terms: Record<string, string[]>;
      ranges: Record<string, [number | null, number | null]>;
      sort: string;
      cursor: number;
      limit: number;
    };

/** Products a listing page holds by default, and at most. */
export const PAGE = { default: 24, max: 100 } as const;
const MAX_FILTERS = 20;
const MAX_VALUES = 50;
const SORT = /^(newest|[A-Za-z0-9][A-Za-z0-9._-]{0,127}_(asc|desc))$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

type Bad = { ok: false; status: 400; error: string };
const bad = (error: string): Bad => ({ ok: false, status: 400, error });

function listingQuery(
  url: URL,
):
  | Bad
  | Pick<Extract<Route, { kind: 'listing' }>, 'terms' | 'ranges' | 'sort' | 'cursor' | 'limit'> {
  const terms: Record<string, string[]> = {};
  const ranges: Record<string, [number | null, number | null]> = {};
  let filters = 0;
  for (const [name, raw] of url.searchParams) {
    if (name.startsWith('f.')) {
      const attr = name.slice(2);
      if (!CODE.test(attr)) return bad(`bad filter ${name}`);
      const values = raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length > MAX_VALUES) return bad(`at most ${MAX_VALUES} values in ${name}`);
      terms[attr] = [...new Set([...(terms[attr] ?? []), ...values])].sort();
      filters++;
    } else if (name.startsWith('r.')) {
      const attr = name.slice(2);
      const [lo = '', hi = '', extra] = raw.split('..');
      if (
        !CODE.test(attr) ||
        extra !== undefined ||
        (lo && !NUMBER.test(lo)) ||
        (hi && !NUMBER.test(hi))
      )
        return bad(`bad range ${name} (lo..hi)`);
      ranges[attr] = [lo ? Number(lo) : null, hi ? Number(hi) : null];
      filters++;
    }
  }
  if (filters > MAX_FILTERS) return bad(`at most ${MAX_FILTERS} filters`);
  const sort = url.searchParams.get('sort') ?? 'newest';
  if (!SORT.test(sort)) return bad('bad sort');
  const cursor = Number(url.searchParams.get('cursor') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return bad('bad cursor');
  const limit = Number(url.searchParams.get('limit') ?? PAGE.default);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max)
    return bad(`limit is 1 to ${PAGE.max}`);
  return { terms, ranges, sort, cursor, limit };
}

export type Parsed = { ok: true; route: Route } | { ok: false; status: 400 | 404; error: string };

const isCode = (s: string) => CODE.test(s);

function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function parse(url: URL): Parsed {
  const parts = url.pathname.split('/');
  // ['', 'v1', channel, locale, kind, ...rest]
  if (parts[1] !== 'v1' || parts.length < 5) return { ok: false, status: 404, error: 'not found' };
  const [, , channel = '', locale = '', kind = '', ...rest] = parts;
  if (!isCode(channel)) return { ok: false, status: 400, error: 'bad channel' };
  if (!LOCALE.test(locale)) return { ok: false, status: 400, error: 'bad locale' };
  const one = rest.length === 1 ? segment(rest[0] as string) : null;
  switch (kind) {
    case 'products': {
      if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) {
        const keys = [
          ...new Set(
            (url.searchParams.get('keys') ?? '')
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean),
          ),
        ];
        if (!keys.length) return { ok: false, status: 400, error: 'keys is required' };
        if (keys.length > BATCH_MAX)
          return { ok: false, status: 400, error: `at most ${BATCH_MAX} keys` };
        if (!keys.every(isCode)) return { ok: false, status: 400, error: 'bad key in keys' };
        return { ok: true, route: { kind: 'batch', channel, locale, keys } };
      }
      if (one === null || !isCode(one)) return { ok: false, status: 400, error: 'bad key' };
      return { ok: true, route: { kind: 'product', channel, locale, key: one } };
    }
    case 'skus':
      if (one === null || !isCode(one)) return { ok: false, status: 400, error: 'bad sku' };
      return { ok: true, route: { kind: 'sku', channel, locale, sku: one } };
    case 'slugs':
      if (one === null || one.length > 200 || !SLUG.test(one))
        return { ok: false, status: 400, error: 'bad slug' };
      return { ok: true, route: { kind: 'slug', channel, locale, slug: one } };
    case 'categories': {
      if (!rest.length) return { ok: true, route: { kind: 'categories', channel, locale } };
      const category = segment(rest[0] as string);
      if (rest.length !== 2 || rest[1] !== 'products')
        return { ok: false, status: 404, error: 'not found' };
      if (category === null || !CODE.test(category)) return bad('bad category');
      const q = listingQuery(url);
      if ('ok' in q) return q;
      return { ok: true, route: { kind: 'listing', channel, locale, category, ...q } };
    }
    default:
      return { ok: false, status: 404, error: 'not found' };
  }
}

/** The URL a route is cached under: its path, and only the query it uses. */
export function canonical(route: Route): string {
  const base = `https://catalog.internal/v1/${route.channel}/${route.locale}`;
  switch (route.kind) {
    case 'product':
      return `${base}/products/${route.key}`;
    case 'batch':
      return `${base}/products?keys=${route.keys.join(',')}`;
    case 'sku':
      return `${base}/skus/${route.sku}`;
    case 'slug':
      return `${base}/slugs/${encodeURIComponent(route.slug)}`;
    case 'categories':
      return `${base}/categories`;
    case 'listing': {
      // Filters in name order, values sorted: every equivalent page shares one cache entry.
      const q = new URLSearchParams();
      for (const attr of Object.keys(route.terms).sort())
        q.set(`f.${attr}`, (route.terms[attr] as string[]).join(','));
      for (const attr of Object.keys(route.ranges).sort()) {
        const [lo, hi] = route.ranges[attr] as [number | null, number | null];
        q.set(`r.${attr}`, `${lo ?? ''}..${hi ?? ''}`);
      }
      if (route.sort !== 'newest') q.set('sort', route.sort);
      if (route.cursor) q.set('cursor', String(route.cursor));
      if (route.limit !== PAGE.default) q.set('limit', String(route.limit));
      const query = q.toString();
      return `${base}/categories/${route.category}/products${query ? `?${query}` : ''}`;
    }
  }
}
