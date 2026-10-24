import { runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DOC_FORMAT, ListingIndex, paths } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { withAncestors } from '../src/listings';
import { api, by, product, settle, setup } from './helpers';

beforeAll(async () => {
  await setup();
  const r = await api.putCategories(
    [
      { code: 'shop', name: { en: 'Shop' } },
      { code: 'hats', parent: 'shop', name: { en: 'Hats' } },
      { code: 'caps', parent: 'hats', name: { en: 'Caps' } },
    ],
    by,
  );
  if (!r.ok) throw new Error(r.issues.join('; '));
});

const indexer = (category: string) => env.LISTINGS.getByName(`web:${category}`);

/** Waits for the changes queue to bring `category` to `n` members, then builds its index. */
async function listing(category: string, n: number): Promise<ListingIndex> {
  for (let i = 0; i < 200 && (await indexer(category).count()) !== n; i++)
    await new Promise((r) => setTimeout(r, 50));
  expect(await indexer(category).count()).toBe(n);
  await runDurableObjectAlarm(indexer(category));
  const object = await env.PUBLISHED.get(paths.listing(DOC_FORMAT, 'web', category));
  if (!object) throw new Error(`no index for ${category}`);
  return new ListingIndex(await object.arrayBuffer());
}

const uidOf = async (key: string) => Number(await env.CARDS.get(paths.uid(DOC_FORMAT, key)));

describe('listing indexes', () => {
  it('lists a product in its category and every ancestor, with facets and sorts', async () => {
    const wool = product({ categories: ['caps'], attributes: { material: 'wool' } });
    const cotton = product({
      categories: ['caps'],
      channels: { web: { visible: true, price: { amount: 500, currency: 'USD' } } },
    });
    await api.putProducts([wool, cotton], { by });
    await settle();
    const caps = await listing('caps', 2);
    const shop = await listing('shop', 2);
    expect(shop.n).toBe(2);
    const r = caps.query({ limit: 10, sort: 'price_asc' });
    expect(r.total).toBe(2);
    expect(r.uids).toEqual([await uidOf(cotton.key), await uidOf(wool.key)]);
    expect(r.terms.material).toEqual([
      { value: 'cotton', count: 1 },
      { value: 'wool', count: 1 },
    ]);
    expect(caps.query({ limit: 10, terms: { material: ['wool'] } }).uids).toEqual([
      await uidOf(wool.key),
    ]);
    // Labels come from the type, per locale.
    expect(caps.labels.fr?.values.material).toEqual({ cotton: 'Coton' });
  });

  it('moves a product between listings, and drops it when it stops being listed', async () => {
    const caps = await indexer('caps').count();
    const hats = await indexer('hats').count();
    const shop = await indexer('shop').count();
    const p = product({ categories: ['caps'] });
    await api.putProducts([p], { by });
    await settle();
    await listing('caps', caps + 1);
    await listing('shop', shop + 1);
    // Moving to Hats keeps it under Shop (and Hats, already counted), and takes it out of Caps.
    await api.putProducts([{ ...p, categories: ['hats'] }], { by });
    await settle();
    await listing('caps', caps);
    const inHats = await listing('hats', hats + 1);
    expect(inHats.query({ limit: 100 }).uids).toContain(await uidOf(p.key));

    // A draft isn't listed anywhere.
    await api.putProducts([{ ...p, categories: ['hats'], status: 'draft' }], { by });
    await settle();
    await listing('hats', hats);
    const inShop = await listing('shop', shop);
    expect(inShop.query({ limit: 100 }).uids).not.toContain(await uidOf(p.key));
  });

  it('keeps the latest change when changes arrive out of order', async () => {
    const stub = indexer('order-test');
    const entry = {
      key: 'x',
      uid: 9,
      version: 2,
      categories: ['order-test'],
      terms: {},
      numbers: {},
      createdAt: 1,
    };
    await stub.apply('web', 'order-test', [{ key: 'x', at: 200, entry }]);
    // An older removal, delivered late, changes nothing.
    await stub.apply('web', 'order-test', [{ key: 'x', at: 100, entry: null }]);
    expect(await stub.count()).toBe(1);
    // A newer removal takes it out; an older listing delivered after it can't bring it back.
    await stub.apply('web', 'order-test', [{ key: 'x', at: 300, entry: null }]);
    await stub.apply('web', 'order-test', [{ key: 'x', at: 250, entry }]);
    expect(await stub.count()).toBe(0);
  });
});

describe('category ancestors', () => {
  it('adds every ancestor once, and stops on a cycle', () => {
    const parents = new Map<string, string | null>([
      ['caps', 'hats'],
      ['hats', 'shop'],
      ['shop', null],
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect([...withAncestors(['caps'], parents)]).toEqual(['caps', 'hats', 'shop']);
    expect([...withAncestors(['a'], parents)]).toEqual(['a', 'b']);
  });
});
