import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DOC_FORMAT, ListingIndex, paths } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyChanges,
  DEBOUNCE_MS,
  debounceMs,
  type ListingIndexer,
  withAncestors,
} from '../src/listings';
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

/**
 * Waits for the changes queue to bring `category` to `n` members, then for an index of those `n`.
 * The indexer's first alarm is due at once, so miniflare may already be running it: run it when
 * it's pending, and read the index only once its recorded member count is right.
 */
async function listing(category: string, n: number): Promise<ListingIndex> {
  for (let i = 0; i < 200 && (await indexer(category).count()) !== n; i++)
    await new Promise((r) => setTimeout(r, 50));
  expect(await indexer(category).count()).toBe(n);
  for (let i = 0; i < 200; i++) {
    await runDurableObjectAlarm(indexer(category));
    const object = await env.PUBLISHED.get(paths.listing(DOC_FORMAT, 'web', category));
    if (object?.customMetadata?.members === String(n))
      return new ListingIndex(await object.arrayBuffer());
    await object?.body.cancel();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no index of ${n} for ${category}`);
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

describe('build pacing', () => {
  const entry = (version: number, price: number) => ({
    key: 'y',
    uid: 11,
    version,
    categories: ['pace-test'],
    terms: { brand: ['acme'] },
    numbers: { price: [price] },
    createdAt: 1,
  });
  const storage = (o: ListingIndexer) => (o as unknown as { ctx: DurableObjectState }).ctx.storage;
  const put = (o: ListingIndexer, k: string, v: string | number) =>
    storage(o).sql.exec('INSERT OR REPLACE INTO settings VALUES (?, ?)', k, String(v));
  const dirty = (o: ListingIndexer) =>
    storage(o).sql.exec<{ v: string }>('SELECT v FROM settings WHERE k = ?', 'dirty').one().v;

  it('waits longer between builds of a larger listing, at most five minutes', () => {
    expect(debounceMs(0)).toBe(DEBOUNCE_MS);
    expect(debounceMs(300_000)).toBe(DEBOUNCE_MS);
    expect(debounceMs(1_000_000)).toBe(50_000);
    expect(debounceMs(6_000_000)).toBe(300_000);
    expect(debounceMs(50_000_000)).toBe(300_000);
  });

  it('schedules the next build by the size of the last one', async () => {
    await runInDurableObject(indexer('pace-test'), async (o) => {
      // No test delay here, so the debounce alone decides.
      const self = o as unknown as { env: Env };
      self.env = { ...self.env, LISTING_DELAY_MS: '0' } as Env;
      const builtAt = Date.now();
      put(o, 'built', builtAt);
      put(o, 'members', 2_000_000);
      await storage(o).deleteAlarm();
      await o.apply('web', 'pace-test', [{ key: 'y', at: 1, entry: entry(1, 100) }]);
      expect(await storage(o).getAlarm()).toBe(builtAt + 100_000);
      put(o, 'members', 10);
      await storage(o).deleteAlarm();
      await o.apply('web', 'pace-test', [{ key: 'y', at: 2, entry: entry(2, 200) }]);
      expect(await storage(o).getAlarm()).toBe(builtAt + DEBOUNCE_MS);
      await storage(o).deleteAlarm();
    });
  });

  it('skips a rebuild for a change that leaves the entry as it was', async () => {
    await runInDurableObject(indexer('pace-test'), async (o) => {
      put(o, 'dirty', 0);
      // A new version (a new description, say) listing as before: only `at` moves.
      await o.apply('web', 'pace-test', [{ key: 'y', at: 3, entry: entry(3, 200) }]);
      expect(dirty(o)).toBe('0');
      const at = storage(o).sql.exec<{ at: number }>('SELECT at FROM members WHERE key = ?', 'y');
      expect(at.one().at).toBe(3);
      // An older change can't undo it, and a new price rebuilds.
      await o.apply('web', 'pace-test', [{ key: 'y', at: 2, entry: entry(2, 100) }]);
      expect(dirty(o)).toBe('0');
      await o.apply('web', 'pace-test', [{ key: 'y', at: 4, entry: entry(4, 300) }]);
      expect(dirty(o)).toBe('1');
      await storage(o).deleteAlarm();
    });
  });

  it('rebuilds for a reindex even when the entry is unchanged', async () => {
    // A reindex (a new document format, a new locale) changes what the index holds, not the
    // entries: its changes are forced, through applyChanges' grouping as well.
    await runInDurableObject(indexer('pace-test'), async (o) => {
      put(o, 'dirty', 0);
    });
    await applyChanges(env, [
      {
        channel: 'web',
        key: 'y',
        at: 5,
        forced: true,
        entry: entry(5, 300),
        left: [],
        search: null,
      },
    ]);
    await runInDurableObject(indexer('pace-test'), async (o) => {
      expect(dirty(o)).toBe('1');
      await storage(o).deleteAlarm();
    });
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
