import { env } from 'cloudflare:workers';
import type { Product } from '@orderloop/core/product';
import { contentHash, DOC_FORMAT, paths, validateProduct } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { meta, typeResolver } from '../src/config';
import { publishKeys } from '../src/publish';
import type { CatalogShard } from '../src/shard';
import { doc, product, setup } from './helpers';

beforeAll(setup);

type State = { locales: string[]; aliases: string[]; uid: number; categories: string[] };

/**
 * The parts of a shard `publishKeys` uses, over one product, with its published state in memory.
 * `publishEnv` can be swapped for one whose writes fail, to stop a pass partway.
 */
function shardFor(publishEnv: Env) {
  const published = new Map<string, State>();
  let current: { product: Product; uid: number; createdAt: number } | null = null;
  const fake = {
    publishEnv,
    publishable: () => current,
    publishedState: (key: string) =>
      [...published]
        .filter(([id]) => id.startsWith(`${key}|`))
        .map(([id, s]) => ({ channel: id.split('|')[1] as string, ...s })),
    recordPublished: (key: string, channel: string, s: State | null) => {
      if (s) published.set(`${key}|${channel}`, s);
      else published.delete(`${key}|${channel}`);
    },
    set(p: Product | null, uid = 0) {
      current = p && { product: p, uid, createdAt: 1 };
    },
  };
  return fake;
}

async function stored(input: ReturnType<typeof product>): Promise<Product> {
  const config = await meta(env).getConfig();
  const v = validateProduct(input, typeResolver(config));
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { ...v.data, version: 1, hash: contentHash(v.data), updatedAt: 1 };
}

/** `env` with the shard doing its own writes (no publisher hop), as `PUBLISH_FANOUT=1` does. */
const oneHop = (e: Env) => ({ ...e, PUBLISH_FANOUT: '1' }) as unknown as Env;

const card = (uid: number, locale = 'en') =>
  env.CARDS.get(paths.card(DOC_FORMAT, 'web', locale, uid));
const uidOf = (key: string) => env.CARDS.get(paths.uid(DOC_FORMAT, key));

describe('publishing and taking down', () => {
  it('removes a deleted product’s cards and its uid entry', async () => {
    const config = await meta(env).getConfig();
    const p = await stored(product());
    const shard = shardFor(oneHop(env));
    shard.set(p, 9101);
    await publishKeys(shard as unknown as CatalogShard, [p.key], config);
    expect(await uidOf(p.key)).toBe('9101');
    expect(await card(9101)).not.toBeNull();
    expect(await card(9101, 'fr')).not.toBeNull();

    shard.set(null);
    await publishKeys(shard as unknown as CatalogShard, [p.key], config);
    expect(await card(9101)).toBeNull();
    expect(await card(9101, 'fr')).toBeNull();
    expect(await uidOf(p.key)).toBeNull();
    expect(await doc(p.key)).toBeNull();
    expect(shard.publishedState(p.key)).toEqual([]);
  });

  it('moves a key created anew before its delete published to the new uid', async () => {
    const config = await meta(env).getConfig();
    const p = await stored(product());
    const shard = shardFor(oneHop(env));
    shard.set(p, 9201);
    await publishKeys(shard as unknown as CatalogShard, [p.key], config);
    // Deleted and created again in one pass's time: the publisher sees only the new product.
    shard.set(p, 9202);
    await publishKeys(shard as unknown as CatalogShard, [p.key], config);
    expect(await uidOf(p.key)).toBe('9202');
    expect(await card(9201)).toBeNull();
    expect(await card(9201, 'fr')).toBeNull();
    expect(await card(9202)).not.toBeNull();
    expect(shard.publishedState(p.key).map((s) => s.uid)).toEqual([9202]);
  });

  it('takes down what a pass that failed partway stored, after the product is deleted', async () => {
    const config = await meta(env).getConfig();
    const p = await stored(product());
    // R2 writes land, then every KV write fails: the pass throws with documents stored.
    const failing = {
      ...oneHop(env),
      CARDS: {
        put: () => Promise.reject(new Error('KV is down')),
        delete: () => Promise.reject(new Error('KV is down')),
      },
    } as unknown as Env;
    const shard = shardFor(failing);
    shard.set(p, 9301);
    await expect(publishKeys(shard as unknown as CatalogShard, [p.key], config)).rejects.toThrow(
      'KV is down',
    );
    // The pass gave up at the first failure; its R2 writes still land (a retry comes seconds later).
    for (let i = 0; i < 50 && !(await doc(p.key, 'fr')); i++) await scheduler.wait(20);
    expect(await doc(p.key)).not.toBeNull();

    // Deleted before the pass is retried: the retry takes down what the failed pass stored.
    shard.publishEnv = oneHop(env);
    shard.set(null);
    await publishKeys(shard as unknown as CatalogShard, [p.key], config);
    expect(await doc(p.key)).toBeNull();
    expect(await doc(p.key, 'fr')).toBeNull();
    for (const v of p.variants)
      expect(await env.PUBLISHED.head(paths.alias(DOC_FORMAT, 'web', `sku:${v.sku}`))).toBeNull();
    expect(shard.publishedState(p.key)).toEqual([]);
  });
});
