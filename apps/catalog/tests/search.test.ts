import { env, exports } from 'cloudflare:workers';
import { DOC_FORMAT, paths } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SearchApi, table } from '../src/search';
import { api, by, product, settle, setup } from './helpers';

beforeAll(setup);

const search = (exports as unknown as { SearchApi: Service<SearchApi> }).SearchApi;
const uidOf = async (key: string) => Number(await env.CARDS.get(paths.uid(DOC_FORMAT, key)));

/** Searches until the changes queue has delivered what's expected. */
async function until(q: string, n: number, locale = 'en') {
  let r = await search.search('web', locale, q, 10, 0);
  for (let i = 0; i < 200 && r.total !== n; i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = await search.search('web', locale, q, 10, 0);
  }
  expect(r.total).toBe(n);
  return r;
}

describe('search', () => {
  const word = `zq${Date.now().toString(36)}`;

  it('finds products by title words, prefixes, SKU and brand, ranked by title first', async () => {
    const inTitle = product({ title: { en: `Merino ${word} sweater`, fr: `Pull ${word}` } });
    const inBrand = product({ title: { en: 'Plain sweater' }, brand: `${word}co` });
    await api.putProducts([inTitle, inBrand], { by });
    await settle();
    // The last term matches as a prefix, so the brand "<word>co" matches too; the title ranks first.
    const r = await until(word, 2);
    expect(r.uids).toEqual([await uidOf(inTitle.key), await uidOf(inBrand.key)]);
    // Every term is required.
    await until(`merino ${word}`, 1);
    await until(`merino ${word} nothing`, 0);
    // SKUs are searchable as their parts.
    await until(`${inTitle.key}`, 1);
    // Each locale has its own index.
    await until(`pull ${word}`, 1, 'fr');
  });

  it('drops a product from search when it is unpublished or deleted', async () => {
    const p = product({ title: { en: `Gone ${word}x hat` } });
    await api.putProducts([p], { by });
    await settle();
    await until(`${word}x`, 1);
    await api.putProducts([{ ...p, status: 'draft' }], { by });
    await settle();
    await until(`${word}x`, 0);
    await api.putProducts([p], { by });
    await settle();
    await until(`${word}x`, 1);
    await api.deleteProducts([p.key], { by });
    await settle();
    await until(`${word}x`, 0);
  });

  it('pages across shards in score order, and treats syntax as text', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      product({ title: { en: `${word}y item ${i}` } }),
    );
    await api.putProducts(many, { by });
    await settle();
    const first = await until(`${word}y`, 30);
    const second = await search.search('web', 'en', `${word}y`, 10, 10);
    expect(second.uids).toHaveLength(10);
    expect(second.uids.some((u) => first.uids.includes(u))).toBe(false);
    expect((await search.search('web', 'en', 'title:"x" OR NEAR(', 10, 0)).total).toBe(0);
    expect(await search.search('web', 'en', '   ', 10, 0)).toEqual({ total: 0, uids: [] });
  });
});

describe('search table names', () => {
  it('keep every channel and locale apart, and leave plain codes where they were', () => {
    const names = ['b2b-eu', 'b2b_eu', 'b2b.eu', 'b2beu'].map((c) => table(c, 'en'));
    expect(new Set(names).size).toBe(names.length);
    // A channel can't stand in for a channel and locale split elsewhere.
    expect(table('a_b', 'c')).not.toBe(table('a', 'b_c'));
    expect(table('web', 'en')).toBe('fts_web__en');
    expect(table('web', 'en-GB')).toBe('fts_web__en_2dGB');
  });
});
