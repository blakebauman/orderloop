/**
 * Publishing: what a shard's alarm does with the products in its outbox. Each product renders once
 * per channel and locale (core's renderForChannel) into a document in R2, alias pointers in R2 (a
 * SKU, GTIN or slug → the product key) and a listing card in KV. What was published before and no
 * longer is (a draft, a delisted channel, a removed SKU, a deleted product) is deleted. All of it is
 * idempotent: publishing the same product twice writes the same bytes.
 */
import {
  type Channel,
  DOC_FORMAT,
  paths,
  productAliases,
  renderForChannel,
} from '@orderloop/core/product';
import { type CatalogConfig, publisher, typeResolver } from './config';
import type { ListingChange } from './listings';
import { orderLines } from './orders';
import { publisherOf, runOps, type WriteOp } from './publisher';
import type { CatalogShard } from './shard';

const JSON_TYPE = 'application/json; charset=utf-8';
/** Publishers per shard when PUBLISH_FANOUT isn't set (publisher.ts). */
const FANOUT = 32;

const union = (a: string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])];

/** Aliases published per channel: slugs only in the locales the channel publishes. */
function channelAliases(all: string[], channel: Channel): string[] {
  return all.filter(
    (a) => !a.startsWith('slug:') || channel.locales.includes(a.split(':')[1] ?? ''),
  );
}

/**
 * Publishes `keys` and returns the listing changes they make (send them once this returns). A key in
 * `forced` (a reindex) is marked so on its listing changes, so its indexes rebuild even when its
 * entries look unchanged.
 */
export async function publishKeys(
  shard: CatalogShard,
  keys: string[],
  config: CatalogConfig,
  forced: Set<string> = new Set(),
  shardNumber = 0,
): Promise<ListingChange[]> {
  const env = shard.publishEnv;
  const resolve = typeResolver(config);
  const fanout = Math.max(1, Number(env.PUBLISH_FANOUT) || FANOUT);
  // Each product's writes, grouped by the publisher that will do them.
  const groups = new Map<number, WriteOp[]>();
  let tasks: WriteOp[] = [];
  const records: (() => void)[] = [];
  // What may be stored once this pass's writes start: recorded before them, so a pass that fails
  // partway (some writes stored, nothing recorded) still takes everything down on a later pass,
  // even if the product is deleted before it retries.
  const intents: (() => void)[] = [];
  const changes: ListingChange[] = [];
  const at = Date.now();

  for (const key of keys) {
    const p = publisherOf(key, fanout);
    tasks = groups.get(p) ?? [];
    groups.set(p, tasks);
    const current = shard.publishable(key);
    const before = new Map(shard.publishedState(key).map((s) => [s.channel, s]));
    // A uid lasts as long as its product: written the first time it publishes, written again when
    // a deleted key was created anew (a new uid) before the delete published, and removed with the
    // product, so catalog-edge's batch lookup can't reach a card through a uid that is gone.
    const uidMoved = current && [...before.values()].some((s) => s.uid !== current.uid);
    if (current && (before.size === 0 || uidMoved))
      tasks.push({ put: 'kv', key: paths.uid(DOC_FORMAT, key), value: String(current.uid) });
    if (!current) tasks.push({ delete: 'kv', key: paths.uid(DOC_FORMAT, key) });
    for (const channel of config.channels) {
      const prev = before.get(channel.code);
      const type = current && resolve(current.product.type, current.product.typeVersion);
      const pub =
        current && type
          ? renderForChannel(current.product, type, channel, {
              uid: current.uid,
              createdAt: current.createdAt,
            })
          : { rendered: null, index: null };

      const nextLocales = pub.rendered?.map((r) => r.locale) ?? [];
      const nextAliases =
        pub.rendered && current ? channelAliases(productAliases(current.product), channel) : [];
      for (const r of pub.rendered ?? []) {
        tasks.push({
          put: 'r2',
          key: paths.doc(DOC_FORMAT, channel.code, r.locale, key),
          body: r.doc,
          contentType: JSON_TYPE,
          version: String(current?.product.version),
        });
        tasks.push({
          put: 'kv',
          key: paths.card(DOC_FORMAT, channel.code, r.locale, current?.uid ?? 0),
          value: r.card,
        });
      }
      // Every pointer is written on every publish, even one this product already published: when
      // an alias moves between products on two shards, the old owner's later publish can delete
      // the new owner's pointer, and the new owner's next publish is what puts it back.
      for (const alias of nextAliases)
        tasks.push({
          put: 'r2',
          key: paths.alias(DOC_FORMAT, channel.code, alias),
          body: JSON.stringify({ key }),
          contentType: JSON_TYPE,
        });

      // Take down what was published and isn't any more. Cards are keyed by uid, so under a new
      // uid every old card goes, even in a locale still published.
      if (prev) {
        const newUid = !!current && prev.uid !== current.uid;
        for (const locale of prev.locales) {
          const kept = nextLocales.includes(locale);
          if (!kept)
            tasks.push({ delete: 'r2', keys: [paths.doc(DOC_FORMAT, channel.code, locale, key)] });
          if (!kept || newUid)
            tasks.push({
              delete: 'kv',
              key: paths.card(DOC_FORMAT, channel.code, locale, prev.uid),
            });
        }
        const keepAliases = new Set(nextAliases);
        const gone = prev.aliases.filter((a) => !keepAliases.has(a));
        if (gone.length)
          tasks.push({
            delete: 'r2',
            keys: gone.map((a) => paths.alias(DOC_FORMAT, channel.code, a)),
          });
      }
      if (prev || (pub.rendered && current))
        intents.push(() =>
          shard.recordPublished(key, channel.code, {
            locales: union(prev?.locales, nextLocales),
            aliases: union(prev?.aliases, nextAliases),
            // The old uid while one is still recorded: a retry then still finds its cards.
            uid: prev?.uid ?? current?.uid ?? 0,
            categories: union(prev?.categories, current ? current.product.categories : []),
          }),
        );
      records.push(() =>
        shard.recordPublished(
          key,
          channel.code,
          pub.rendered && current
            ? {
                locales: nextLocales,
                aliases: nextAliases,
                uid: current.uid,
                categories: current.product.categories,
              }
            : null,
        ),
      );
      if (pub.index || prev)
        changes.push({
          channel: channel.code,
          key,
          at,
          rev: config.rev,
          ...(forced.has(key) ? { forced: true } : {}),
          entry: pub.index,
          left: prev?.categories ?? [],
          search: pub.rendered?.map((r) => ({ ...r.search, locale: r.locale })) ?? null,
          ...(channel.code === env.ORDERS_CHANNEL && current && type && pub.rendered
            ? { order: orderLines(current.product, type, channel) }
            : {}),
        });
    }
  }
  for (const intent of intents) intent();
  // One publisher alone needs no hop; otherwise every publisher at once.
  if (fanout === 1) await runOps(env, groups.get(0) ?? []);
  else
    await Promise.all(
      [...groups].map(([p, ops]) => (ops.length ? publisher(env, shardNumber, p).write(ops) : 0)),
    );
  // Recorded only once everything above is stored, so a failed pass republishes in full.
  for (const record of records) record();
  return changes;
}
