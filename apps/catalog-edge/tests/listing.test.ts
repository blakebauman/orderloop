import { env, exports } from 'cloudflare:workers';
import { buildListingIndex, type IndexEntry } from '@orderloop/core/product';
import { DOC_FORMAT, paths } from '@orderloop/core/product/paths';
import { beforeAll, describe, expect, it } from 'vitest';

const get = (path: string, init?: RequestInit) =>
  (exports as unknown as { default: Fetcher }).default.fetch(
    `https://catalog.example${path}`,
    init,
  );

const entry = (uid: number, brand: string, color: string[], price: number): IndexEntry => ({
  key: `p${uid}`,
  uid,
  version: 1,
  categories: ['tees'],
  terms: { brand: [brand], color },
  numbers: { price: [price] },
  createdAt: uid,
});

beforeAll(async () => {
  // Newest first: p5, p4, p3, p2, p1.
  const entries = [
    entry(1, 'acme', ['red'], 1500),
    entry(2, 'acme', ['blue'], 900),
    entry(3, 'globex', ['red', 'blue'], 2500),
    entry(4, 'acme', ['red'], 500),
    entry(5, 'hooli', [], 3000),
  ];
  const bytes = buildListingIndex(entries, {
    terms: ['brand', 'color'],
    numbers: ['price'],
    sorts: ['price'],
    buckets: { price: [1000, 2000] },
    labels: { en: { attributes: { color: 'Colour' }, values: { color: { red: 'Red' } } } },
  });
  await env.PUBLISHED.put(paths.listing(DOC_FORMAT, 'web', 'tees'), bytes);
  for (const e of entries)
    await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', e.uid), JSON.stringify({ key: e.key }));
});

type Page = {
  total: number;
  next: number | null;
  sorts: string[];
  products: { key: string }[];
  facets: Record<
    string,
    { label: string; values: { value: string; label: string; count: number }[] }
  >;
  ranges: Record<string, unknown>;
};
const page = async (path: string) => (await (await get(path)).json()) as Page;
const keys = (body: Page) => body.products.map((p) => p.key);

describe('category listings', () => {
  it('pages newest first, with facets over the whole result, labels and range buckets', async () => {
    expect((await get('/v1/web/en/categories/tees/products?limit=2')).status).toBe(200);
    const body = await page('/v1/web/en/categories/tees/products?limit=2');
    expect(body).toMatchObject({ total: 5, next: 2, sorts: ['newest', 'price_asc', 'price_desc'] });
    expect(keys(body)).toEqual(['p5', 'p4']);
    expect(body.facets.color).toEqual({
      label: 'Colour',
      values: [
        { value: 'red', label: 'Red', count: 3 },
        { value: 'blue', label: 'blue', count: 2 },
      ],
    });
    expect(body.ranges.price).toMatchObject({
      label: 'price',
      min: 500,
      max: 3000,
      buckets: [
        { lo: null, hi: 1000, count: 2 },
        { lo: 1000, hi: 2000, count: 1 },
        { lo: 2000, hi: null, count: 2 },
      ],
    });
    const next = await page(`/v1/web/en/categories/tees/products?limit=2&cursor=${body.next}`);
    expect(keys(next)).toEqual(['p3', 'p2']);
  });

  it('filters by terms and ranges and sorts by price, counting facets disjunctively', async () => {
    const body = await page(
      '/v1/web/en/categories/tees/products?f.color=red&r.price=..2000&sort=price_asc',
    );
    expect(keys(body)).toEqual(['p4', 'p1']);
    expect(body.total).toBe(2);
    // Picking red still shows how many blue products there are under the price filter.
    expect(body.facets.color?.values).toEqual([
      { value: 'red', label: 'Red', count: 2 },
      { value: 'blue', label: 'blue', count: 1 },
    ]);
  });

  it('refuses a sort the index lacks, bad filters and limits, and an unknown category', async () => {
    const sort = await get('/v1/web/en/categories/tees/products?sort=weight_asc');
    expect(sort.status).toBe(400);
    expect(await sort.json()).toMatchObject({ error: 'unsupported sort' });
    expect((await get('/v1/web/en/categories/tees/products?r.price=cheap')).status).toBe(400);
    expect((await get('/v1/web/en/categories/tees/products?limit=500')).status).toBe(400);
    expect((await get('/v1/web/en/categories/tees/products?cursor=-1')).status).toBe(400);
    expect((await get('/v1/web/en/categories/nope/products')).status).toBe(404);
    expect((await get('/v1/web/en/categories/tees/other')).status).toBe(404);
  });

  it('tags a page with an ETag of its body and answers 304 when it still matches', async () => {
    const path = '/v1/web/en/categories/tees/products?limit=2';
    const r = await get(path);
    const etag = r.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get(path, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-tag')).toBe('cat:tees,ch:web');
    expect(await again.text()).toBe('');
    expect((await get(path, { headers: { 'if-none-match': '"other", *' } })).status).toBe(304);
    expect((await get(path, { headers: { 'if-none-match': '"other"' } })).status).toBe(200);
    // Another page, another body: another ETag.
    const next = await get('/v1/web/en/categories/tees/products?limit=2&cursor=2');
    expect(next.headers.get('etag')).not.toBe(etag);
    // A card that changes changes the page's ETag, though the index didn't.
    await env.CARDS.put(
      paths.card(DOC_FORMAT, 'web', 'en', 5),
      JSON.stringify({ key: 'p5', v: 2 }),
    );
    const changed = await get(path, { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 5), JSON.stringify({ key: 'p5' }));
  });

  it('keeps the internal index path off the public API', async () => {
    expect((await get('/_idx/web/tees')).status).toBe(404);
  });
});

describe('listing cache keys', () => {
  it('gives equivalent pages one canonical URL', async () => {
    const { canonical, parse } = await import('../src/routes');
    const url = (q: string) => {
      const p = parse(new URL(`https://x/v1/web/en/categories/tees/products?${q}`));
      if (!p.ok) throw new Error(p.error);
      return canonical(p.route);
    };
    const a = url('f.color=red,blue&f.brand=acme&r.price=10..&limit=24&utm_source=mail');
    const b = url('f.brand=acme&f.color=blue&f.color=red,red&r.price=10..');
    expect(a).toBe(b);
    expect(a).toBe(
      'https://catalog.internal/v1/web/en/categories/tees/products?f.brand=acme&f.color=blue%2Cred&r.price=10..',
    );
    expect(url('')).toBe('https://catalog.internal/v1/web/en/categories/tees/products');
  });
});
