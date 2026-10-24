/**
 * Delivery: the cached entrypoint. Everything it answers is already rendered by the catalog's
 * publisher, so it reads and streams; it never parses a document. Workers Caching sits in front of
 * it: a hit never runs this code, concurrent misses for a URL run it once, and a stale entry is
 * served while one background request revalidates it. That revalidation carries the stored ETag,
 * which R2 checks itself (`onlyIf`), so an unchanged document costs a 304 with no body read.
 *
 * Freshness without purging: documents are fresh for a minute. Urgent changes are purged by tag
 * through `purge`, called by the gateway's queue consumer.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ListingIndex } from '@orderloop/core/product/listing';
import { CODE, DOC_FORMAT, paths, tags } from '@orderloop/core/product/paths';
import { parse, type Route } from './routes';

/** Fresh a minute; served stale for a day while revalidating, or a week if R2 fails. */
export const FRESH = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';
/** A miss is remembered briefly, so a product that appears is seen within half a minute. */
export const MISSING = 'public, max-age=30';
const JSON_TYPE = 'application/json; charset=utf-8';
/** Listing indexes: rebuilt at most every 15 s, so cached for 30. */
const INDEX_FRESH = 'public, max-age=30, stale-while-revalidate=300';
/** Where Delivery fetches a listing index from itself, through the cache. Not a public route. */
const INDEX_PATH = '/_idx/';
/** Decoded indexes an isolate keeps, by bytes. */
const INDEX_BUDGET = 64 * 1024 * 1024;
/** How long an isolate trusts a decoded index before revalidating it. */
const INDEX_TRUST_MS = 30_000;
/** Facet values returned per attribute, most frequent first. */
const FACET_VALUES = 50;

type Held = { index: ListingIndex; etag: string; bytes: number; checked: number };
const held = new Map<string, Held>();
let heldBytes = 0;

function keep(id: string, h: Held) {
  const old = held.get(id);
  if (old) heldBytes -= old.bytes;
  held.delete(id);
  held.set(id, h);
  heldBytes += h.bytes;
  // Least recently used out first (a Map iterates in insertion order).
  for (const [k, v] of held) {
    if (heldBytes <= INDEX_BUDGET || k === id) break;
    held.delete(k);
    heldBytes -= v.bytes;
  }
}

type CachePurge = {
  purge(o: { tags: string[] }): Promise<{ success: boolean; errors: unknown[] }>;
};

function json(body: BodyInit | null, status: number, headers: Record<string, string>) {
  return new Response(body, { status, headers: { 'content-type': JSON_TYPE, ...headers } });
}

function missing(error: string, cacheTags: string[]) {
  return json(JSON.stringify({ error }), 404, {
    'cache-control': MISSING,
    'cache-tag': cacheTags.join(','),
  });
}

export class Delivery extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INDEX_PATH)) return this.indexBlob(request, url);
    const parsed = parse(url);
    if (!parsed.ok) return json(JSON.stringify({ error: parsed.error }), parsed.status, {});
    const route = parsed.route;
    switch (route.kind) {
      case 'product':
        return this.document(request, route, route.key);
      case 'sku':
      case 'slug': {
        const alias =
          route.kind === 'sku' ? `sku:${route.sku}` : `slug:${route.locale}:${route.slug}`;
        const pointer = await this.env.PUBLISHED.get(paths.alias(DOC_FORMAT, route.channel, alias));
        if (!pointer) return missing(`no product for ${route.kind}`, [tags.channel(route.channel)]);
        const { key } = (await pointer.json()) as { key: string };
        return this.document(request, route, key);
      }
      case 'batch':
        return this.batch(route);
      case 'listing':
        return this.listing(route);
      case 'categories': {
        const object = await this.env.PUBLISHED.get(
          paths.categories(DOC_FORMAT, route.channel, route.locale),
          {
            onlyIf: request.headers,
          },
        );
        const cacheTags = [tags.categories, tags.channel(route.channel)].join(',');
        if (!object) return missing('no such channel or locale', [tags.categories]);
        return this.respond(object, cacheTags);
      }
    }
  }

  private async document(request: Request, route: Route, key: string): Promise<Response> {
    const cacheTags = [tags.product(key), tags.channel(route.channel)];
    const object = await this.env.PUBLISHED.get(
      paths.doc(DOC_FORMAT, route.channel, route.locale, key),
      {
        onlyIf: request.headers,
      },
    );
    if (!object) return missing('no such product', cacheTags);
    return this.respond(object, cacheTags.join(','));
  }

  /** The stored bytes, or a 304 when the request's ETag still matches (R2 decided). */
  private respond(object: R2Object | R2ObjectBody, cacheTags: string): Response {
    const headers = {
      etag: object.httpEtag,
      'cache-control': FRESH,
      'cache-tag': cacheTags,
      'last-modified': object.uploaded.toUTCString(),
    };
    if (!('body' in object)) return new Response(null, { status: 304, headers });
    return json(object.body, 200, headers);
  }

  /** Cards for up to 100 keys, in the order asked, `null` for any not published. */
  private async batch(route: Extract<Route, { kind: 'batch' }>): Promise<Response> {
    const uids = await this.env.CARDS.get(route.keys.map((k) => paths.uid(DOC_FORMAT, k)));
    const cardKeys = route.keys.map((k) => {
      const uid = uids.get(paths.uid(DOC_FORMAT, k));
      return uid ? paths.card(DOC_FORMAT, route.channel, route.locale, Number(uid)) : null;
    });
    const wanted = cardKeys.filter((k): k is string => k !== null);
    const cards = wanted.length
      ? await this.env.CARDS.get(wanted)
      : new Map<string, string | null>();
    // Cards are stored serialized: join them as they are.
    const body = `{"products":[${cardKeys.map((k) => (k && cards.get(k)) ?? 'null').join(',')}]}`;
    return json(body, 200, {
      'cache-control': FRESH,
      'cache-tag': [tags.channel(route.channel), ...route.keys.map(tags.product)].join(','),
    });
  }

  /** A listing index's bytes from R2 (only ever asked for by `loadIndex`, through the cache). */
  private async indexBlob(request: Request, url: URL): Promise<Response> {
    const [channel = '', category = ''] = url.pathname.slice(INDEX_PATH.length).split('/');
    if (!CODE.test(channel) || !CODE.test(category)) return new Response(null, { status: 404 });
    const object = await this.env.PUBLISHED.get(paths.listing(DOC_FORMAT, channel, category), {
      onlyIf: request.headers,
    });
    const headers = {
      'cache-control': INDEX_FRESH,
      'cache-tag': [tags.category(category), tags.channel(channel)].join(','),
    };
    if (!object)
      return new Response(null, { status: 404, headers: { ...headers, 'cache-control': MISSING } });
    if (!('body' in object))
      return new Response(null, { status: 304, headers: { ...headers, etag: object.httpEtag } });
    return new Response(object.body, {
      headers: { ...headers, etag: object.httpEtag, 'content-type': 'application/octet-stream' },
    });
  }

  /**
   * A category's decoded index. Held per isolate, revalidated every 30 s through the cache with
   * its ETag (an unchanged index is a 304: nothing is downloaded or decoded again).
   */
  private async loadIndex(channel: string, category: string): Promise<ListingIndex | null> {
    const id = `${channel}/${category}`;
    const h = held.get(id);
    if (h && Date.now() - h.checked < INDEX_TRUST_MS) return h.index;
    const self = (this.ctx as unknown as { exports: { Delivery: Fetcher } }).exports.Delivery;
    const r = await self.fetch(
      new Request(`https://catalog.internal${INDEX_PATH}${id}`, {
        headers: h ? { 'if-none-match': h.etag } : {},
      }),
    );
    if (r.status === 304 && h) {
      keep(id, { ...h, checked: Date.now() });
      return h.index;
    }
    if (!r.ok) {
      if (h) held.delete(id);
      return null;
    }
    const buffer = await r.arrayBuffer();
    const index = new ListingIndex(buffer);
    keep(id, {
      index,
      etag: r.headers.get('etag') ?? '',
      bytes: buffer.byteLength,
      checked: Date.now(),
    });
    return index;
  }

  /** One page of a category: filtered, sorted, faceted over the whole result, cards in order. */
  private async listing(route: Extract<Route, { kind: 'listing' }>): Promise<Response> {
    const cacheTags = [tags.category(route.category), tags.channel(route.channel)];
    const index = await this.loadIndex(route.channel, route.category);
    if (!index) return missing('no such category', cacheTags);
    if (route.sort !== 'newest' && !index.sorts.includes(route.sort))
      return json(
        JSON.stringify({ error: 'unsupported sort', sorts: ['newest', ...index.sorts] }),
        400,
        {
          'cache-control': MISSING,
        },
      );
    const r = index.query({
      terms: route.terms,
      ranges: route.ranges,
      sort: route.sort,
      cursor: route.cursor,
      limit: route.limit,
    });
    const keys = r.uids.map((uid) => paths.card(DOC_FORMAT, route.channel, route.locale, uid));
    const cards = keys.length ? await this.env.CARDS.get(keys) : new Map<string, string | null>();
    const labels = index.labels[route.locale];
    const facets = Object.fromEntries(
      Object.entries(r.terms).map(([attr, counts]) => [
        attr,
        {
          label: labels?.attributes[attr] ?? attr,
          values: counts.slice(0, FACET_VALUES).map((c) => ({
            value: c.value,
            label: labels?.values[attr]?.[c.value] ?? c.value,
            count: c.count,
          })),
        },
      ]),
    );
    const ranges = Object.fromEntries(
      Object.entries(r.ranges).map(([attr, range]) => [
        attr,
        { label: labels?.attributes[attr] ?? attr, ...range },
      ]),
    );
    // Cards are stored serialized: join them as they are (a card missing from KV is skipped).
    const products = keys.map((k) => cards.get(k)).filter((c): c is string => !!c);
    const body =
      `{"total":${r.total},"next":${r.next ?? 'null'},"sorts":${JSON.stringify(['newest', ...index.sorts])},` +
      `"products":[${products.join(',')}],"facets":${JSON.stringify(facets)},"ranges":${JSON.stringify(ranges)}}`;
    return json(body, 200, { 'cache-control': FRESH, 'cache-tag': cacheTags.join(',') });
  }

  /** Purges cached responses by tag. Workers Caching scopes a purge to the entrypoint calling it. */
  async purge(cacheTags: string[]): Promise<{ success: boolean; skipped?: true }> {
    const cache = (this.ctx as unknown as { cache?: CachePurge }).cache;
    // Local dev and tests have no Workers Caching.
    if (!cache) return { success: true, skipped: true };
    const r = await cache.purge({ tags: cacheTags });
    if (!r.success) console.error('purge refused', JSON.stringify(r.errors));
    return { success: r.success };
  }
}
