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
import { DOC_FORMAT, paths, tags } from '@orderloop/core/product/paths';
import { parse, type Route } from './routes';

/** Fresh a minute; served stale for a day while revalidating, or a week if R2 fails. */
export const FRESH = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';
/** A miss is remembered briefly, so a product that appears is seen within half a minute. */
export const MISSING = 'public, max-age=30';
const JSON_TYPE = 'application/json; charset=utf-8';

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
    const parsed = parse(new URL(request.url));
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
