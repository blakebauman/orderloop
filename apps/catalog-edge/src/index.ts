/**
 * catalog-edge: the public, read-only catalog API. This default entrypoint is the gateway, with no
 * cache in front of it: it answers `/health` and CORS preflights, refuses what isn't a read,
 * parses the route and forwards the route's canonical URL to the cached Delivery entrypoint
 * (delivery.ts). It records each request in Analytics Engine without waiting on it.
 *
 * Its queue consumer drains the catalog's purge queue: one batch at a time, up to 100 tags a call.
 */
import type { PurgeMessage } from '@orderloop/core/product';
import type { Delivery } from './delivery';
import { canonical, parse } from './routes';

export { Delivery } from './delivery';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag, cf-cache-status',
  'timing-allow-origin': '*',
};

type Exports = { Delivery: Service<Delivery> };

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'access-control-allow-methods': 'GET, HEAD',
          'access-control-allow-headers': 'if-none-match',
          'access-control-max-age': '86400',
        },
      });
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(JSON.stringify({ error: 'read only' }), {
        status: 405,
        headers: { ...CORS, allow: 'GET, HEAD, OPTIONS', 'content-type': 'application/json' },
      });
    const parsed = parse(url);
    if (!parsed.ok)
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: parsed.status,
        headers: { ...CORS, 'content-type': 'application/json' },
      });

    // Only the canonical URL and a validator reach the cache: no cookies, no client headers.
    const headers = new Headers();
    const inm = request.headers.get('if-none-match');
    if (inm) headers.set('if-none-match', inm);
    const exports = (ctx as unknown as { exports: Exports }).exports;
    const upstream = await exports.Delivery.fetch(
      new Request(canonical(parsed.route), { headers }),
    );
    const response = new Response(request.method === 'HEAD' ? null : upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);

    env.ANALYTICS?.writeDataPoint({
      blobs: [
        parsed.route.kind,
        parsed.route.channel,
        String(response.status),
        response.headers.get('cf-cache-status') ?? 'NONE',
      ],
      doubles: [Date.now() - started],
      indexes: [parsed.route.channel],
    });
    return response;
  },

  async queue(batch, _env, ctx) {
    const all = [...new Set(batch.messages.flatMap((m) => (m.body as PurgeMessage).tags))];
    const exports = (ctx as unknown as { exports: Exports }).exports;
    for (let i = 0; i < all.length; i += 100) {
      const r = await exports.Delivery.purge(all.slice(i, i + 100));
      if (!r.success) {
        // Rate limited (or refused): try the whole batch again once the bucket refills.
        batch.retryAll({ delaySeconds: 30 });
        return;
      }
    }
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
