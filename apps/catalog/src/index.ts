/**
 * The product catalog Worker. No public routes: the web app and catalog-edge reach it through the
 * CatalogApi entrypoint over service bindings. Its queue consumer applies feed parts, routes
 * listing changes to their indexers and keeps what the three dead-letter queues receive.
 */
import { isDeadLetterQueue, keepDeadLetters } from './dead-letters';
import { applyPart, type FeedPart, failPart } from './feed-import';
import { applyChanges, changesIn } from './listings';
import { applyOrders } from './orders';
import { applySearch } from './search';

export { CatalogApi } from './api';
export { FeedImport } from './feed-import';
export { CatalogFeeds } from './feeds';
export { ListingIndexer } from './listings';
export { CatalogMeta } from './meta';
export { CatalogPublisher } from './publisher';
export { SearchApi, SearchShard } from './search';
export { CatalogShard } from './shard';

/** Deliveries of a part before its rows count as rejected (the consumer's max_retries + 1). */
const PART_ATTEMPTS = 5;

/**
 * Seconds before the next delivery of a message on its `attempts`th failure: `base`, doubling on
 * each attempt, up to `cap`. A shard or indexer that is down gets room to come back rather than
 * the whole budget of retries in a few seconds.
 */
export const backoff = (attempts: number, base: number, cap: number) =>
  Math.min(base * 2 ** Math.max(attempts - 1, 0), cap);

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },

  async queue(batch, env) {
    // Queue names carry the deployment's suffix: dispatch on the base name. The dead-letter
    // queues' names start like their queues', so they go first.
    if (isDeadLetterQueue(batch.queue)) {
      await keepDeadLetters(batch, env.PUBLISHED, (a) => backoff(a, 30, 900));
      return;
    }
    if (batch.queue.startsWith('orderloop-catalog-changes')) {
      // One call per listing for the whole batch, so a failure can't be pinned on one message:
      // every message is retried, backing off (changes are idempotent by `at`).
      try {
        const changes = batch.messages.flatMap((m) => changesIn(m.body));
        await Promise.all([
          applyChanges(env, changes),
          applySearch(env, changes),
          applyOrders(env, changes),
        ]);
      } catch (err) {
        console.error('listing changes failed, retrying the batch:', err);
        for (const m of batch.messages) m.retry({ delaySeconds: backoff(m.attempts, 5, 900) });
        return;
      }
      batch.ackAll();
      return;
    }
    await Promise.all(
      batch.messages.map(async (msg) => {
        const part = msg.body as FeedPart;
        try {
          await applyPart(env, part);
          msg.ack();
        } catch (err) {
          if (msg.attempts >= PART_ATTEMPTS) {
            await failPart(env, part, err);
            msg.ack();
          } else msg.retry({ delaySeconds: backoff(msg.attempts, 10, 300) });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;
