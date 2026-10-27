import { env } from 'cloudflare:workers';
import { DOC_FORMAT, PRODUCT_SHARDS, productShard } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  backupObject,
  chunkKey,
  type Manifest,
  OBJECTS,
  readManifest,
  stubOf,
} from '../src/backup';
import { api, by, finish, product, settle, setup } from './helpers';

beforeAll(setup);

const lines = async (key: string) =>
  ((await (await env.PUBLISHED.get(key))?.text()) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** The bucket as `backups/` is under its lock: a put of a key that exists is refused. */
function locked(bucket: R2Bucket, puts: string[] = [], failAfter = Infinity): R2Bucket {
  return Object.assign(Object.create(bucket), {
    head: bucket.head.bind(bucket),
    get: bucket.get.bind(bucket),
    list: bucket.list.bind(bucket),
    put: async (key: string, ...rest: unknown[]) => {
      if (await bucket.head(key))
        throw new Error('put: The object is locked by the bucket policy. (10069)');
      if (puts.length >= failAfter) throw new Error('the step died');
      puts.push(key);
      return (bucket.put as (...a: unknown[]) => Promise<R2Object>)(key, ...rest);
    },
  });
}

/** `count` product keys that all live on one shard, and that shard. */
function sameShard(prefix: string, count: number): { n: number; keys: string[] } {
  const by = new Map<number, string[]>();
  for (let i = 0; ; i++) {
    const key = `${prefix}-${i}`;
    const n = productShard(key);
    const list = by.get(n) ?? [];
    list.push(key);
    by.set(n, list);
    if (list.length === count) return { n, keys: list };
  }
}

describe('catalog backups', () => {
  it('backs up meta and every shard: chunks per table and a manifest with their row counts', async () => {
    const items = [product(), product(), product()];
    expect((await api.putProducts(items, { by })).map((r) => r.status)).toEqual([
      'created',
      'created',
      'created',
    ]);
    await settle();

    const out = await finish<{ date: string; objects: number; rows: number }>(env.CATALOG_BACKUP);
    expect(out.objects).toBe(1 + PRODUCT_SHARDS);
    const manifest = (await readManifest(env.PUBLISHED, out.date)) as Manifest;
    expect(manifest).toMatchObject({ format: 1, date: out.date, docFormat: DOC_FORMAT });
    expect(Object.keys(manifest.objects)).toEqual(OBJECTS);
    expect(manifest.objects.meta?.tables.types).toMatchObject({ rows: 1, chunks: 1 });
    expect(manifest.objects.meta?.tables.channels?.rows).toBe(1);
    expect(manifest.objects.meta?.tables.categories?.rows).toBe(2);
    // The derived and transient tables aren't copied.
    expect(Object.keys(manifest.objects['shard-0']?.tables ?? {})).not.toContain('outbox');
    expect(Object.keys(manifest.objects['shard-0']?.tables ?? {})).not.toContain('published');

    for (const p of items) {
      const object = `shard-${productShard(p.key)}`;
      const products = manifest.objects[object]?.tables.products;
      expect(products?.rows).toBeGreaterThan(0);
      const rows = await lines(chunkKey(`backups/${out.date}/${object}/`, 'products', 0));
      expect(rows.length).toBe(products?.rows);
      expect(rows.find((r) => r.key === p.key)).toMatchObject({ key: p.key, type: 'apparel' });
    }
    const total = Object.values(manifest.objects).reduce(
      (sum, o) => sum + (o.tables.products?.rows ?? 0),
      0,
    );
    expect(total).toBe(items.length);

    // Again the same day: the manifest is there, so it copies nothing.
    expect(await finish(env.CATALOG_BACKUP)).toEqual({ date: out.date, skipped: true });
  });

  it('resumes a copy cut short without writing over any chunk the lock keeps', async () => {
    const { n, keys } = sameShard(`lock${Date.now().toString(36)}`, 6);
    await api.putProducts(
      keys
        .slice(0, 5)
        .map((key) => product({ key, variants: [{ sku: `${key}-S`, attributes: { size: 'S' } }] })),
      { by },
    );
    const date = '2026-01-02';
    const object = `shard-${n}`;
    const stub = stubOf(env, object);

    // The first attempt dies after the bookmark and two chunks of two rows.
    const first: string[] = [];
    await expect(
      backupObject(locked(env.PUBLISHED, first, 3), date, object, stub, 2),
    ).rejects.toThrow('the step died');
    expect(first).toEqual([
      `backups/${date}/${object}/bookmark.json`,
      chunkKey(`backups/${date}/${object}/`, 'products', 0),
      chunkKey(`backups/${date}/${object}/`, 'products', 1),
    ]);

    // A product written before the retry: the retry carries on after the rows already copied.
    const sixth = keys[5] as string;
    await api.putProducts(
      [product({ key: sixth, variants: [{ sku: `${sixth}-S`, attributes: { size: 'S' } }] })],
      { by },
    );
    const second: string[] = [];
    const copy = await backupObject(locked(env.PUBLISHED, second), date, object, stub, 2);
    expect(second).not.toContain(chunkKey(`backups/${date}/${object}/`, 'products', 0));
    expect(second).not.toContain(chunkKey(`backups/${date}/${object}/`, 'products', 1));
    expect(copy.tables.products).toMatchObject({ rows: 6, chunks: 3 });
    const copied: string[] = [];
    for (let c = 0; c < 3; c++)
      for (const r of await lines(chunkKey(`backups/${date}/${object}/`, 'products', c)))
        copied.push(r.key as string);
    expect(copied.sort()).toEqual([...keys].sort());

    // Once more, with everything there: nothing is put at all.
    const third: string[] = [];
    expect(await backupObject(locked(env.PUBLISHED, third), date, object, stub, 2)).toEqual(copy);
    expect(third).toEqual([]);
  });
});
