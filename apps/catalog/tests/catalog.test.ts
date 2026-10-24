import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  aliasShard,
  DOC_FORMAT,
  paths,
  productShard,
  productTypeSchema,
} from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { alias, api, apparel, by, doc, product, settle, setup } from './helpers';

beforeAll(setup);

describe('writing products', () => {
  it('stores, versions and publishes a product in every locale', async () => {
    const p = product();
    expect(await api.putProducts([p], { by })).toEqual([
      { key: p.key, status: 'created', version: 1 },
    ]);
    await settle();
    const en = await doc(p.key);
    expect(en).toMatchObject({
      key: p.key,
      version: 1,
      title: p.title?.en,
      price: { amount: 1999, currency: 'USD' },
    });
    expect((await doc(p.key, 'fr'))?.attributes).toEqual({
      material: { code: 'cotton', label: 'Coton' },
    });
    expect(await alias(`sku:${p.key}-S`)).toEqual({ key: p.key });
    expect(await alias(`slug:en:${p.slug?.en}`)).toEqual({ key: p.key });

    const stored = await api.getProduct(p.key);
    expect(stored).toMatchObject({ key: p.key, version: 1, typeVersion: 1 });
    const uid = await runInDurableObject(
      env.SHARD.getByName(`shard-${productShard(p.key)}`),
      (_o, state) =>
        state.storage.sql
          .exec<{ uid: number }>('SELECT uid FROM products WHERE key = ?', p.key)
          .one().uid,
    );
    // catalog-edge looks a card up by key through this entry.
    expect(await env.CARDS.get(paths.uid(DOC_FORMAT, p.key))).toBe(String(uid));
    const card = await env.CARDS.get(paths.card(DOC_FORMAT, 'web', 'en', uid), 'json');
    expect(card).toMatchObject({
      key: p.key,
      variants: 2,
      attributes: { material: { code: 'cotton', label: 'Cotton' } },
    });
    expect(await api.resolveAlias(`sku:${p.key}-M`)).toBe(p.key);
  });

  it('writes nothing for an unchanged product, and a new version for a change', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    expect(await api.putProducts([p], { by })).toEqual([
      { key: p.key, status: 'unchanged', version: 1 },
    ]);
    expect(await env.SHARD.getByName(`shard-${productShard(p.key)}`).pending()).toBe(0);

    const cheaper = {
      ...p,
      channels: { web: { visible: true, price: { amount: 1499, currency: 'USD' } } },
    };
    // Urgent: the publisher also queues the product's cache tag for catalog-edge to purge.
    expect(await api.putProducts([cheaper], { by, urgent: true })).toEqual([
      { key: p.key, status: 'updated', version: 2 },
    ]);
    await settle();
    expect(await doc(p.key)).toMatchObject({ version: 2, price: { amount: 1499 } });
  });

  it('rejects invalid products with every reason, alongside valid ones', async () => {
    const good = product();
    const results = await api.putProducts(
      [{ ...product(), attributes: { material: 'silk' } }, good, { ...product(), type: 'shoes' }],
      { by },
    );
    expect(results.map((r) => r.status)).toEqual(['rejected', 'created', 'rejected']);
    expect(results[0]?.issues).toEqual([
      { path: 'attributes.material', message: 'expected one of material values' },
    ]);
    expect(results[2]?.issues).toEqual([{ path: 'type', message: 'unknown type shoes' }]);
  });

  it('refuses a repeated key in one batch, keeping the last row', async () => {
    const p = product();
    const results = await api.putProducts([p, { ...p, brand: 'Later' }], { by });
    expect(results.map((r) => r.status)).toEqual(['rejected', 'created']);
    expect((await api.getProduct(p.key))?.brand).toBe('Later');
  });
});

describe('aliases', () => {
  it('refuses a SKU another product holds, and frees it when that product lets go', async () => {
    const first = product();
    await api.putProducts([first], { by });
    const sku = `${first.key}-S`;
    const second = product({ variants: [{ sku, attributes: { size: 'S' } }] });
    const [refused] = await api.putProducts([second], { by });
    expect(refused).toMatchObject({
      status: 'rejected',
      issues: [{ path: `sku:${sku}`, message: `already used by ${first.key}` }],
    });
    // The refused product claimed its slug before the conflict: it was given back.
    expect(await api.resolveAlias(`slug:en:${second.slug?.en}`)).toBeNull();

    await api.putProducts(
      [{ ...first, variants: [{ sku: `${first.key}-L`, attributes: { size: 'L' } }] }],
      { by },
    );
    expect(await api.resolveAlias(`sku:${sku}`)).toBeNull();
    expect((await api.putProducts([second], { by }))[0]?.status).toBe('created');
    expect(await api.resolveAlias(`sku:${sku}`)).toBe(second.key);
    await settle();
    expect(await alias(`sku:${sku}`)).toEqual({ key: second.key });
  });

  it('takes over a claim whose product no longer holds it', async () => {
    const p = product();
    const sku = `${p.key}-S`;
    // A claim left behind by a release that never happened.
    await runInDurableObject(
      env.SHARD.getByName(`shard-${aliasShard(`sku:${sku}`)}`),
      (_o, state) => {
        state.storage.sql.exec('INSERT INTO aliases VALUES (?, ?)', `sku:${sku}`, 'ghost-product');
      },
    );
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('created');
    expect(await api.resolveAlias(`sku:${sku}`)).toBe(p.key);
  });
});

describe('shard batches', () => {
  it('applies a batch id once', async () => {
    const p = product();
    const { validateProduct } = await import('@orderloop/core/product');
    const type = productTypeSchema.parse(apparel);
    const v = validateProduct(p, () => type);
    if (!v.ok) throw new Error('fixture is invalid');
    const n = productShard(p.key);
    const stub = env.SHARD.getByName(`shard-${n}`);
    const batch = { shard: n, batchId: `feed-1:part-${p.key}`, rows: [v.data], rev: 0, by };
    const first = await stub.apply(batch);
    const again = await stub.apply({ ...batch, rows: [{ ...v.data, brand: 'Changed' }] });
    expect(again).toEqual(first);
    expect((await api.getProduct(p.key))?.brand).toBeUndefined();
  });

  it('refuses to be called as a different shard', async () => {
    const stub = env.SHARD.getByName('shard-3');
    await stub.apply({ shard: 3, batchId: crypto.randomUUID(), rows: [], rev: 0, by });
    // Inside the object: an error thrown across RPC also surfaces as an unhandled rejection.
    await runInDurableObject(stub, async (shard) => {
      await expect(
        shard.apply({ shard: 4, batchId: crypto.randomUUID(), rows: [], rev: 0, by }),
      ).rejects.toThrow('shard 3 was called as shard 4');
    });
  });
});

describe('unpublishing', () => {
  it('takes a product down when it becomes a draft, and back up when active', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    await api.putProducts([{ ...p, status: 'draft' }], { by });
    await settle();
    expect(await doc(p.key)).toBeNull();
    expect(await doc(p.key, 'fr')).toBeNull();
    expect(await alias(`sku:${p.key}-S`)).toBeNull();
    // The draft still owns its SKUs: only publishing stopped.
    expect(await api.resolveAlias(`sku:${p.key}-S`)).toBe(p.key);
    await api.putProducts([p], { by });
    await settle();
    expect(await doc(p.key)).toMatchObject({ version: 3 });
  });

  it('removes a dropped variant’s alias, and everything of a deleted product', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await settle();
    await api.putProducts([{ ...p, variants: [p.variants[0] as never] }], { by });
    await settle();
    expect(await alias(`sku:${p.key}-M`)).toBeNull();
    expect(await alias(`sku:${p.key}-S`)).toEqual({ key: p.key });

    expect(await api.deleteProducts([p.key, 'never-existed'], { by })).toEqual([
      { key: p.key, status: 'deleted', version: 2 },
      { key: 'never-existed', status: 'unchanged' },
    ]);
    await settle();
    expect(await doc(p.key)).toBeNull();
    expect(await alias(`sku:${p.key}-S`)).toBeNull();
    expect(await api.resolveAlias(`sku:${p.key}-S`)).toBeNull();
    expect(await api.getProduct(p.key)).toBeNull();
  });
});

describe('types, channels and categories', () => {
  it('versions types additively', async () => {
    const before = (await api.listTypes()).find((t) => t.code === 'apparel');
    const version = (before?.version ?? 1) + 1;
    const added = await api.putType(
      {
        ...apparel,
        version,
        attributes: [...apparel.attributes, { code: `fit${version}`, kind: 'text' }],
      },
      by,
    );
    expect(added.ok).toBe(true);
    const breaking = await api.putType(
      {
        ...apparel,
        version: version + 1,
        attributes: apparel.attributes?.filter((a) => a.code !== 'material'),
      },
      by,
    );
    expect(breaking).toMatchObject({
      ok: false,
      issues: expect.arrayContaining(['material removed (deprecate it instead)']),
    });
    expect(await api.putType({ ...apparel, code: 'brand-new', version: 2 }, by)).toEqual({
      ok: false,
      issues: ['a new type starts at version 1'],
    });
    // Products keep validating against the latest version without naming it.
    const p = product();
    expect((await api.putProducts([p], { by }))[0]?.status).toBe('created');
    expect((await api.getProduct(p.key))?.typeVersion).toBe(version);
  });

  it('refuses categories with an unknown parent or a cycle, and publishes the tree', async () => {
    expect(
      await api.putCategories([{ code: 'orphan', parent: 'nowhere', name: { en: 'x' } }], by),
    ).toEqual({
      ok: false,
      issues: ['orphan: unknown parent nowhere'],
    });
    expect(
      await api.putCategories([{ code: 'tops', parent: 'tees', name: { en: 'Tops' } }], by),
    ).toEqual({
      ok: false,
      issues: ['tops: parent cycle through tops'],
    });
    const tree = await env.PUBLISHED.get(paths.categories(DOC_FORMAT, 'web', 'fr'));
    const body = (await tree?.json()) as {
      categories: { code: string; name: string; parent: string | null }[];
    };
    expect(body.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'tops', name: 'Hauts', parent: null }),
        expect.objectContaining({ code: 'tees', name: 'Tees', parent: 'tops' }),
      ]),
    );
  });

  it('refuses a channel whose default locale it does not publish', async () => {
    expect(
      await api.putChannel(
        { code: 'b2b', name: 'B2B', currency: 'EUR', locales: ['de'], defaultLocale: 'en' },
        by,
      ),
    ).toEqual({ ok: false, issues: ['defaultLocale must be one of locales'] });
  });
});
