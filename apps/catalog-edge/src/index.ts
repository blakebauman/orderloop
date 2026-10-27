/**
 * catalog-edge: the public, read-only catalog API. This default entrypoint is the gateway, with no
 * cache in front of it: it answers `/health` and CORS preflights, refuses what isn't a read,
 * parses the route and forwards the route's canonical URL to the cached Delivery entrypoint
 * (delivery.ts). It records each request in Analytics Engine without waiting on it.
 *
 * Its queue consumer drains the catalog's purge queue: one batch at a time, up to 100 tags a call,
 * one call every 12 seconds (purges are rationed: 5 a minute).
 */
import type { PurgeMessage } from '@orderloop/core/product';
import type { Delivery } from './delivery';
import { canonical, parse } from './routes';

export { Delivery } from './delivery';

// On every response: readable from any origin (the catalog is public and read-only), never
// sniffed as anything but its content type, and only ever over HTTPS.
const PUBLIC = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag, cf-cache-status',
  'timing-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
};

type Exports = { Delivery: Service<Delivery> };

/** Tags per purge call, and the pause after each call: Cloudflare allows 5 calls a minute. */
export const PURGE_TAGS = 100;
export const PURGE_PACE_MS = 12_000;
/**
 * Calls one batch makes before handing the rest back to the queue: 40 paced calls take 8 minutes,
 * well inside a consumer's 15. An urgent purge is never dropped for its age: a document stays
 * servable stale for a day (`stale-while-revalidate`), so a missed purge would mean the old
 * copy is served once more, perhaps hours later.
 */
export const PURGE_CALLS = 40;

/**
 * Seconds before a message handed back goes out again: `base`, doubling with each delivery, up to
 * `cap`. Every hand-back spends one of the queue's retries, so a backlog that keeps outrunning
 * the purge ration spreads out instead of reaching the dead-letter queue within minutes.
 */
export const backoff = (attempts: number, base: number, cap: number) =>
  Math.min(base * 2 ** Math.max(attempts - 1, 0), cap);

/** `skipped`: nothing was purged (no Workers Caching here), so nothing was rationed either. */
type Purge = (tags: string[]) => Promise<{ success: boolean; skipped?: true }>;

/**
 * Purges a batch's tags, paced, oldest message first. A refused call retries what it didn't cover
 * once the bucket refills; after PURGE_CALLS calls the rest goes back to the queue. Both back off
 * with the message's attempts.
 */
export async function drain(
  batch: MessageBatch<PurgeMessage>,
  purge: Purge,
  wait: (ms: number) => Promise<void> = (ms) => scheduler.wait(ms),
): Promise<void> {
  const queue = [...batch.messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const done = new Set<string>();
  let calls = 0;
  while (queue.length) {
    if (calls >= PURGE_CALLS) {
      for (const m of queue) m.retry({ delaySeconds: backoff(m.attempts, 12, 300) });
      return;
    }
    // Whole messages, up to PURGE_TAGS tags (one larger than that goes alone, split below).
    const take: Message<PurgeMessage>[] = [];
    const tags = new Set<string>();
    for (const m of queue) {
      const fresh = m.body.tags.filter((t) => !done.has(t) && !tags.has(t));
      if (take.length && tags.size + fresh.length > PURGE_TAGS) break;
      take.push(m);
      for (const t of fresh) tags.add(t);
    }
    if (!take.length) break;
    queue.splice(0, take.length);
    const all = [...tags];
    for (let i = 0; i < all.length; i += PURGE_TAGS) {
      const chunk = all.slice(i, i + PURGE_TAGS);
      const r = await purge(chunk);
      if (!r.success) {
        // Rate limited (or refused): try these again once the bucket refills.
        for (const m of [...take, ...queue])
          m.retry({ delaySeconds: backoff(m.attempts, 30, 900) });
        return;
      }
      calls++;
      for (const t of chunk) done.add(t);
      if (!r.skipped) await wait(PURGE_PACE_MS);
    }
    for (const m of take) m.ack();
  }
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: {
          ...PUBLIC,
          'access-control-allow-methods': 'GET, HEAD',
          'access-control-allow-headers': 'if-none-match',
          'access-control-max-age': '86400',
        },
      });
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(JSON.stringify({ error: 'read only' }), {
        status: 405,
        headers: { ...PUBLIC, allow: 'GET, HEAD, OPTIONS', 'content-type': 'application/json' },
      });
    const parsed = parse(url);
    if (!parsed.ok)
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: parsed.status,
        headers: { ...PUBLIC, 'content-type': 'application/json' },
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
    for (const [k, v] of Object.entries(PUBLIC)) response.headers.set(k, v);

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
    const exports = (ctx as unknown as { exports: Exports }).exports;
    await drain(batch as MessageBatch<PurgeMessage>, (t) => exports.Delivery.purge(t));
  },
} satisfies ExportedHandler<Env>;
