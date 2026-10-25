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
import {
  LISTING_MAX_BYTES,
  LISTING_SEGMENTS,
  ListingIndex,
  listingLabels,
  listingSorts,
  queryListing,
} from '@orderloop/core/product/listing';
import { CODE, DOC_FORMAT, paths, tags } from '@orderloop/core/product/paths';
import { SEARCH_DEPTH } from '@orderloop/core/product/search';
import { parse, type Route } from './routes';

/** Fresh a minute; served stale for a day while revalidating, or a week if R2 fails. */
export const FRESH = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';
/** A miss is remembered briefly, so a product that appears is seen within half a minute. */
export const MISSING = 'public, max-age=30';
const JSON_TYPE = 'application/json; charset=utf-8';
/** Listing index segments: rebuilt at most every 15 s (longer for large ones), so cached for 30. */
const INDEX_FRESH = 'public, max-age=30, stale-while-revalidate=300';
/**
 * Where Delivery fetches a listing index segment from itself, through the cache
 * (`/_idx/<channel>/<category>/<segment>`). Not a public route.
 */
const INDEX_PATH = '/_idx/';
/**
 * Listing index limits, mutable only so tests can shrink them. `budget`: decoded listings an
 * isolate keeps, by bytes (an isolate has 128 MB in all). `max`: the most one listing's segments
 * may add up to; a listing over it is never buffered. `trustMs`: how long a held segment is
 * trusted before it is revalidated.
 */
export const INDEX_LIMITS = {
  budget: 32 * 1024 * 1024,
  max: LISTING_MAX_BYTES,
  trustMs: 30_000,
};
/** How long a request waits on another's load of the same listing before loading it itself. */
const SHARED_LOAD_MS = 5_000;
/** Facet values returned per attribute, most frequent first. */
const FACET_VALUES = 50;
/** Key → uid entries an isolate remembers (a uid never changes while its product exists). */
const UID_ENTRIES = 50_000;

/** A held segment; `index` null for one with no object (an empty segment), held all the same. */
type Held = { index: ListingIndex | null; etag: string; bytes: number; checked: number };
/** A listing's held segments, and their bytes. Kept and evicted as a unit. */
type HeldListing = { segments: Held[]; bytes: number };
const held = new Map<string, HeldListing>();
let heldBytes = 0;
/** Listing loads in flight, so concurrent requests for one category download it once. */
const loading = new Map<string, Promise<(ListingIndex | null)[] | null>>();
const uidCache = new Map<string, number>();

class IndexTooLarge extends Error {}
/** A segment this Worker can't decode: built in another format, until a reindex rebuilds it. */
class IndexUnreadable extends Error {}

/**
 * Holds listing `id`, most recently used, and evicts other listings, least recently used first,
 * until the budget fits. Never a segment of the listing being kept: one listing over the budget
 * is held on its own rather than re-downloaded in part on every request.
 */
function keep(id: string, listing: HeldListing) {
  const old = held.get(id);
  if (old) heldBytes -= old.bytes;
  held.delete(id);
  held.set(id, listing);
  heldBytes += listing.bytes;
  // A Map iterates in insertion order, so the least recently used come first.
  for (const [k, v] of held) {
    if (heldBytes <= INDEX_LIMITS.budget || k === id) break;
    held.delete(k);
    heldBytes -= v.bytes;
  }
}

function forget(id: string) {
  const old = held.get(id);
  if (!old) return;
  held.delete(id);
  heldBytes -= old.bytes;
}

/** What this isolate holds (tests): each listing's segments, and the bytes counted. */
export function heldListings(): { bytes: number; listings: Map<string, Held[]> } {
  return {
    bytes: heldBytes,
    listings: new Map([...held].map(([id, l]) => [id, l.segments.map((h) => ({ ...h }))])),
  };
}

/** A listing's segments to query, or null when it has none at all. */
function present(segments: Held[]): (ListingIndex | null)[] | null {
  return segments.some((s) => s.index) ? segments.map((s) => s.index) : null;
}

/** Drops everything held (tests). */
export function forgetListings() {
  held.clear();
  heldBytes = 0;
}

/** The catalog's SearchApi entrypoint, as this Worker calls it. */
export type CatalogSearch = {
  search(
    channel: string,
    locale: string,
    q: string,
    limit: number,
    offset: number,
  ): Promise<{ total: number; uids: number[]; partial?: true }>;
};

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

/** A strong ETag for a body assembled here: a hash of its bytes. */
async function bodyEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  let hex = '';
  for (const b of new Uint8Array(digest, 0, 16)) hex += b.toString(16).padStart(2, '0');
  return `"${hex}"`;
}

/** Whether an If-None-Match header names `etag` (weak or strong, or `*`). */
export function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

/**
 * An assembled JSON body with its ETag, or a 304 when the request already has it: what lets the
 * cache revalidate a stale listing or batch without storing it again.
 */
async function assembled(
  request: Request,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const etag = await bodyEtag(body);
  if (matches(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { ...headers, etag } });
  return json(body, 200, { ...headers, etag });
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
        return this.batch(request, route);
      case 'listing':
        return this.listing(request, route);
      case 'search':
        return this.search(route);
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

  /**
   * Products' uids, from this isolate's memory or KV (`null` for a key never published). A key
   * deleted and created again gets a new uid, so a remembered uid whose card is gone is looked up
   * again (`refresh`).
   */
  private async uids(keys: string[], refresh = false): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const unknown = refresh ? keys : keys.filter((k) => !uidCache.has(k));
    if (unknown.length) {
      const found = await this.env.CARDS.get(unknown.map((k) => paths.uid(DOC_FORMAT, k)));
      for (const k of unknown) {
        const v = found.get(paths.uid(DOC_FORMAT, k));
        if (v) {
          uidCache.delete(k);
          uidCache.set(k, Number(v));
          if (uidCache.size > UID_ENTRIES) uidCache.delete(uidCache.keys().next().value as string);
        } else uidCache.delete(k);
        out.set(k, v ? Number(v) : null);
      }
    }
    for (const k of keys) if (!out.has(k)) out.set(k, uidCache.get(k) ?? null);
    return out;
  }

  /** Cards for up to 100 keys, in the order asked, `null` for any not published. */
  private async batch(
    request: Request,
    route: Extract<Route, { kind: 'batch' }>,
  ): Promise<Response> {
    const card = (uid: number | null | undefined) =>
      uid ? paths.card(DOC_FORMAT, route.channel, route.locale, uid) : null;
    const read = async (keys: string[], refresh: boolean) => {
      const uids = await this.uids(keys, refresh);
      const wanted = keys.map((k) => card(uids.get(k))).filter((k): k is string => k !== null);
      const cards = wanted.length
        ? await this.env.CARDS.get(wanted)
        : new Map<string, string | null>();
      return new Map(keys.map((k) => [k, cards.get(card(uids.get(k)) ?? '') ?? null]));
    };
    const remembered = new Set(route.keys.filter((k) => uidCache.has(k)));
    const found = await read(route.keys, false);
    // A card missing under a remembered uid: the uid may have changed (see `uids`).
    const recheck = route.keys.filter((k) => found.get(k) === null && remembered.has(k));
    if (recheck.length) for (const [k, v] of await read(recheck, true)) found.set(k, v);
    // Cards are stored serialized: join them as they are.
    const body = `{"products":[${route.keys.map((k) => found.get(k) ?? 'null').join(',')}]}`;
    return assembled(request, body, {
      'cache-control': FRESH,
      'cache-tag': [tags.channel(route.channel), ...route.keys.map(tags.product)].join(','),
    });
  }

  /** A listing index segment's bytes from R2 (only ever asked for by `fetchListing`, through the cache). */
  private async indexBlob(request: Request, url: URL): Promise<Response> {
    const parts = url.pathname.slice(INDEX_PATH.length).split('/');
    const [channel = '', category = '', n = ''] = parts;
    const segment = Number(n);
    if (
      parts.length !== 3 ||
      !CODE.test(channel) ||
      !CODE.test(category) ||
      !/^(0|[1-9][0-9]*)$/.test(n) ||
      segment >= LISTING_SEGMENTS
    )
      return new Response(null, { status: 404 });
    const object = await this.env.PUBLISHED.get(
      paths.listing(DOC_FORMAT, channel, category, segment),
      { onlyIf: request.headers },
    );
    const headers = {
      'cache-control': INDEX_FRESH,
      'cache-tag': [tags.category(category), tags.channel(channel)].join(','),
    };
    if (!object)
      return new Response(null, { status: 404, headers: { ...headers, 'cache-control': MISSING } });
    if (!('body' in object))
      return new Response(null, { status: 304, headers: { ...headers, etag: object.httpEtag } });
    // The length up front, so `fetchListing` can refuse a listing over the cap before reading it.
    return new Response(object.body, {
      headers: {
        ...headers,
        etag: object.httpEtag,
        'content-type': 'application/octet-stream',
        'content-length': String(object.size),
      },
    });
  }

  /**
   * A category's decoded index segments, null where a segment has none (a small category needn't
   * have members in every segment), or null when no segment exists at all. Held per isolate as a
   * unit; a segment is revalidated through the cache with its ETag once it has been held 30 s (an
   * unchanged one is a 304: nothing is downloaded or decoded again).
   */
  private async loadListing(
    channel: string,
    category: string,
  ): Promise<(ListingIndex | null)[] | null> {
    const id = `${channel}/${category}`;
    const h = held.get(id);
    const now = Date.now();
    if (h?.segments.every((s) => now - s.checked < INDEX_LIMITS.trustMs)) {
      keep(id, h);
      return present(h.segments);
    }
    // Another request is loading it: wait for that (briefly; a load that fails or stalls, say
    // because its request was cancelled, is done again here).
    const inFlight = loading.get(id);
    if (inFlight) {
      const shared = await Promise.race([
        inFlight.then(
          (segments) => ({ segments }),
          () => null,
        ),
        scheduler.wait(SHARED_LOAD_MS).then(() => null),
      ]);
      if (shared) return shared.segments;
    }
    const load = this.fetchListing(id, h);
    loading.set(id, load);
    try {
      return await load;
    } finally {
      if (loading.get(id) === load) loading.delete(id);
    }
  }

  /**
   * Revalidates or downloads every segment not trusted any more, in parallel. The bodies are
   * buffered only once the whole listing is known to fit `INDEX_LIMITS.max`, held segments
   * included, so no listing ever takes the isolate's memory with it.
   */
  private async fetchListing(
    id: string,
    h: HeldListing | undefined,
  ): Promise<(ListingIndex | null)[] | null> {
    const self = (this.ctx as unknown as { exports: { Delivery: Fetcher } }).exports.Delivery;
    const now = Date.now();
    const answers = await Promise.all(
      Array.from({ length: LISTING_SEGMENTS }, async (_, s) => {
        const prior = h?.segments[s];
        if (prior && now - prior.checked < INDEX_LIMITS.trustMs) return { prior, r: null };
        const r = await self.fetch(
          new Request(`https://catalog.internal${INDEX_PATH}${id}/${s}`, {
            headers: prior?.etag ? { 'if-none-match': prior.etag } : {},
          }),
        );
        return { prior, r };
      }),
    );
    // A body already read or cancelled refuses to cancel again; that's fine.
    const cancel = () =>
      Promise.all(answers.map((a) => a.r?.body?.cancel().catch(() => undefined)));
    let total = 0;
    for (const { prior, r } of answers) {
      if (!r || (r.status === 304 && prior)) total += prior?.bytes ?? 0;
      else if (r.ok) total += Number(r.headers.get('content-length') ?? 0);
    }
    if (total > INDEX_LIMITS.max) {
      await cancel();
      forget(id);
      throw new IndexTooLarge(`listing index ${id} is ${total} bytes`);
    }
    const checked = Date.now();
    let bytes = 0;
    const segments = await Promise.all(
      answers.map(async ({ prior, r }): Promise<Held> => {
        if (!r) return prior as Held;
        if (r.status === 304 && prior) return { ...prior, checked };
        // No object: an empty segment, held so it isn't asked for again until revalidated.
        // Anything else failed: empty this once, and asked for again next time.
        if (!r.ok) {
          await r.body?.cancel();
          return { index: null, etag: '', bytes: 0, checked: r.status === 404 ? checked : 0 };
        }
        const buffer = await r.arrayBuffer();
        // A body larger than its content-length said is still held to the cap.
        bytes += buffer.byteLength;
        if (bytes > INDEX_LIMITS.max)
          throw new IndexTooLarge(`listing index ${id} is over the cap`);
        let index: ListingIndex;
        try {
          index = new ListingIndex(buffer);
        } catch (err) {
          throw new IndexUnreadable(`listing index ${id}: ${(err as Error).message}`);
        }
        return {
          index,
          etag: r.headers.get('etag') ?? '',
          bytes: buffer.byteLength,
          checked,
        };
      }),
    ).catch(async (err) => {
      await cancel();
      forget(id);
      throw err;
    });
    keep(id, { segments, bytes: segments.reduce((n, s) => n + s.bytes, 0) });
    return present(segments);
  }

  /** One page of a category: filtered, sorted, faceted over the whole result, cards in order. */
  private async listing(
    request: Request,
    route: Extract<Route, { kind: 'listing' }>,
  ): Promise<Response> {
    const cacheTags = [tags.category(route.category), tags.channel(route.channel)];
    let segments: (ListingIndex | null)[] | null;
    try {
      segments = await this.loadListing(route.channel, route.category);
    } catch (err) {
      if (err instanceof IndexUnreadable) {
        console.error(err.message);
        // A deploy changed the index format and this listing isn't rebuilt yet: not a partial page.
        return json(JSON.stringify({ error: 'listing rebuilding' }), 503, {
          'cache-control': MISSING,
        });
      }
      if (!(err instanceof IndexTooLarge)) throw err;
      console.error(err.message);
      // Not a passing failure: the category is larger than a listing can be. Search covers it.
      return json(JSON.stringify({ error: 'listing too large' }), 503, {
        'cache-control': MISSING,
      });
    }
    if (!segments) return missing('no such category', cacheTags);
    const sorts = listingSorts(segments);
    if (route.sort !== 'newest' && !sorts.includes(route.sort))
      return json(JSON.stringify({ error: 'unsupported sort', sorts: ['newest', ...sorts] }), 400, {
        'cache-control': MISSING,
      });
    const r = queryListing(segments, {
      terms: route.terms,
      ranges: route.ranges,
      sort: route.sort,
      cursor: route.cursor ?? undefined,
      limit: route.limit,
    });
    const keys = r.uids.map((uid) => paths.card(DOC_FORMAT, route.channel, route.locale, uid));
    const cards = keys.length ? await this.env.CARDS.get(keys) : new Map<string, string | null>();
    const labels = listingLabels(segments)[route.locale];
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
      `{"total":${r.total},"next":${r.next ? JSON.stringify(r.next) : 'null'},"sorts":${JSON.stringify(['newest', ...sorts])},` +
      `"products":[${products.join(',')}],"facets":${JSON.stringify(facets)},"ranges":${JSON.stringify(ranges)}}`;
    return assembled(request, body, { 'cache-control': FRESH, 'cache-tag': cacheTags.join(',') });
  }

  /**
   * Keyword search through the catalog's search shards. On the first page, a query that is one
   * code-like word and some product's exact SKU puts that product first.
   */
  private async search(route: Extract<Route, { kind: 'search' }>): Promise<Response> {
    const catalog = this.env.CATALOG as unknown as CatalogSearch;
    const exact = async (): Promise<number | null> => {
      if (route.cursor || !CODE.test(route.q)) return null;
      for (const sku of new Set([route.q.toUpperCase(), route.q])) {
        const pointer = await this.env.PUBLISHED.get(
          paths.alias(DOC_FORMAT, route.channel, `sku:${sku}`),
        );
        if (!pointer) continue;
        const { key } = (await pointer.json()) as { key: string };
        const uid = await this.env.CARDS.get(paths.uid(DOC_FORMAT, key));
        if (uid) return Number(uid);
      }
      return null;
    };
    const [found, sku] = await Promise.all([
      catalog.search(route.channel, route.locale, route.q, route.limit, route.cursor),
      exact(),
    ]);
    const uids =
      sku === null
        ? found.uids
        : [sku, ...found.uids.filter((u) => u !== sku)].slice(0, route.limit);
    const keys = uids.map((uid) => paths.card(DOC_FORMAT, route.channel, route.locale, uid));
    const cards = keys.length ? await this.env.CARDS.get(keys) : new Map<string, string | null>();
    const products = keys.map((k) => cards.get(k)).filter((c): c is string => !!c);
    // An exact-SKU product full-text search didn't match counts too.
    const total = found.total + (sku !== null && !found.uids.includes(sku) ? 1 : 0);
    const end = route.cursor + route.limit;
    const next = end < Math.min(total, SEARCH_DEPTH) ? end : null;
    const partial = found.partial ? ',"partial":true' : '';
    const body = `{"total":${total},"next":${next ?? 'null'},"products":[${products.join(',')}]${partial}}`;
    // A partial answer (a shard failed) is kept only briefly, so the full one replaces it soon.
    return json(body, 200, {
      'cache-control': found.partial ? MISSING : FRESH,
      'cache-tag': tags.channel(route.channel),
    });
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
