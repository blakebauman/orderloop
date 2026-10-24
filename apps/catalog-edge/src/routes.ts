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
 */
// The zod-free part of core only: this Worker's bundle stays small.
import { BATCH_MAX, CODE, LOCALE, SLUG } from '@orderloop/core/product/paths';

export type Route =
  | { kind: 'product'; channel: string; locale: string; key: string }
  | { kind: 'batch'; channel: string; locale: string; keys: string[] }
  | { kind: 'sku'; channel: string; locale: string; sku: string }
  | { kind: 'slug'; channel: string; locale: string; slug: string }
  | { kind: 'categories'; channel: string; locale: string };

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
    case 'categories':
      if (rest.length) return { ok: false, status: 404, error: 'not found' };
      return { ok: true, route: { kind: 'categories', channel, locale } };
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
  }
}
