/**
 * The product catalog Worker. No public routes: the web app and catalog-edge reach it through the
 * CatalogApi entrypoint over service bindings. Its queue consumer applies feed parts and routes
 * listing changes to their indexers.
 */
import { applyPart, type FeedPart, failPart } from './feed-import';
import { applyChanges, type ListingChange } from './listings';
import { applySearch } from './search';

export { CatalogApi } from './api';
export { FeedImport } from './feed-import';
export { CatalogFeeds } from './feeds';
export { ListingIndexer } from './listings';
export { CatalogMeta } from './meta';
export { SearchApi, SearchShard } from './search';
export { CatalogShard } from './shard';

/** Deliveries of a part before its rows count as rejected (the consumer's max_retries + 1). */
const PART_ATTEMPTS = 5;

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },

  async queue(batch, env) {
    // Queue names carry the deployment's suffix: dispatch on the base name.
    if (batch.queue.startsWith('orderloop-catalog-changes')) {
      // One call per listing for the whole batch; a failure retries the batch (changes are
      // idempotent by `at`).
      const changes = batch.messages.map((m) => m.body as ListingChange);
      await Promise.all([applyChanges(env, changes), applySearch(env, changes)]);
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
          } else msg.retry({ delaySeconds: 10 * msg.attempts });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;
