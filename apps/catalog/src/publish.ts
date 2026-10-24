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
import { type CatalogConfig, typeResolver } from './config';
import type { CatalogShard } from './shard';

const JSON_TYPE = { contentType: 'application/json; charset=utf-8' };
/** Storage writes in flight at once, per alarm. */
const CONCURRENCY = 32;

async function inBatches(tasks: (() => Promise<unknown>)[]) {
  for (let i = 0; i < tasks.length; i += CONCURRENCY)
    await Promise.all(tasks.slice(i, i + CONCURRENCY).map((t) => t()));
}

/** Aliases published per channel: slugs only in the locales the channel publishes. */
function channelAliases(all: string[], channel: Channel): string[] {
  return all.filter(
    (a) => !a.startsWith('slug:') || channel.locales.includes(a.split(':')[1] ?? ''),
  );
}

export async function publishKeys(shard: CatalogShard, keys: string[], config: CatalogConfig) {
  const env = shard.publishEnv;
  const resolve = typeResolver(config);
  const tasks: (() => Promise<unknown>)[] = [];
  const records: (() => void)[] = [];

  for (const key of keys) {
    const current = shard.publishable(key);
    const before = new Map(shard.publishedState(key).map((s) => [s.channel, s]));
    // A product's uid never changes: write the key → uid entry the first time it publishes.
    if (current && before.size === 0)
      tasks.push(() => env.CARDS.put(paths.uid(DOC_FORMAT, key), String(current.uid)));
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
        tasks.push(() =>
          env.PUBLISHED.put(paths.doc(DOC_FORMAT, channel.code, r.locale, key), r.doc, {
            httpMetadata: JSON_TYPE,
            customMetadata: { version: String(current?.product.version) },
          }),
        );
        tasks.push(() =>
          env.CARDS.put(paths.card(DOC_FORMAT, channel.code, r.locale, current?.uid ?? 0), r.card),
        );
      }
      for (const alias of nextAliases)
        tasks.push(() =>
          env.PUBLISHED.put(paths.alias(DOC_FORMAT, channel.code, alias), JSON.stringify({ key }), {
            httpMetadata: JSON_TYPE,
          }),
        );

      // Take down what was published and isn't any more.
      if (prev) {
        const keepLocales = new Set(nextLocales);
        for (const locale of prev.locales)
          if (!keepLocales.has(locale)) {
            tasks.push(() =>
              env.PUBLISHED.delete(paths.doc(DOC_FORMAT, channel.code, locale, key)),
            );
            tasks.push(() =>
              env.CARDS.delete(paths.card(DOC_FORMAT, channel.code, locale, prev.uid)),
            );
          }
        const keepAliases = new Set(nextAliases);
        const gone = prev.aliases.filter((a) => !keepAliases.has(a));
        if (gone.length)
          tasks.push(() =>
            env.PUBLISHED.delete(gone.map((a) => paths.alias(DOC_FORMAT, channel.code, a))),
          );
      }
      records.push(() =>
        shard.recordPublished(
          key,
          channel.code,
          pub.rendered && current
            ? { locales: nextLocales, aliases: nextAliases, uid: current.uid }
            : null,
        ),
      );
    }
  }
  await inBatches(tasks);
  // Recorded only once everything above is stored, so a failed pass republishes in full.
  for (const record of records) record();
}
