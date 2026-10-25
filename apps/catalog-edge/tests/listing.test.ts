import { env, exports } from 'cloudflare:workers';
import {
  buildListingIndex,
  type IndexEntry,
  LISTING_SEGMENTS,
  type ListingSpec,
  listingSegment,
} from '@orderloop/core/product';
import { DOC_FORMAT, paths } from '@orderloop/core/product/paths';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { forgetListings, heldListings, INDEX_LIMITS } from '../src/delivery';

const get = (path: string, init?: RequestInit) =>
  (exports as unknown as { default: Fetcher }).default.fetch(
    `https://catalog.example${path}`,
    init,
  );

const entry = (
  uid: number,
  brand: string,
  color: string[],
  price: number,
  createdAt = uid * 1_000,
): IndexEntry => ({
  key: `p${uid}`,
  uid,
  version: 1,
  categories: ['tees'],
  terms: { brand: [brand], color },
  numbers: { price: [price] },
  createdAt,
});

/** Publishes a category's index as the indexers do: one blob per segment that has members. */
async function publish(category: string, entries: IndexEntry[], spec: ListingSpec) {
  const parts: IndexEntry[][] = Array.from({ length: LISTING_SEGMENTS }, () => []);
  for (const e of entries) parts[listingSegment(e.key)]?.push(e);
  for (const [s, part] of parts.entries())
    if (part.length)
      await env.PUBLISHED.put(
        paths.listing(DOC_FORMAT, 'web', category, s),
        buildListingIndex(part, spec),
      );
  for (const e of entries)
    await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', e.uid), JSON.stringify({ key: e.key }));
  return parts.map((p) => p.length);
}

/** 300 products over every segment, with many ties on creation time and price. */
const many = Array.from({ length: 300 }, (_, i) =>
  entry(
    1_000 + i,
    ['acme', 'globex', 'hooli'][i % 3] as string,
    i % 4 ? ['red'] : ['blue'],
    ((i * 7919) % 13) * 100,
    Math.floor(i / 10) * 1_000,
  ),
);
let teesSegments: number[] = [];

beforeAll(async () => {
  // Newest first: p5, p4, p3, p2, p1.
  const entries = [
    entry(1, 'acme', ['red'], 1500),
    entry(2, 'acme', ['blue'], 900),
    entry(3, 'globex', ['red', 'blue'], 2500),
    entry(4, 'acme', ['red'], 500),
    entry(5, 'hooli', [], 3000),
  ];
  teesSegments = await publish('tees', entries, {
    terms: ['brand', 'color'],
    numbers: ['price'],
    sorts: ['price'],
    buckets: { price: [1000, 2000] },
    labels: { en: { attributes: { color: 'Colour' }, values: { color: { red: 'Red' } } } },
  });
  await publish('many', many, { terms: ['brand', 'color'], numbers: ['price'], sorts: ['price'] });
});

type Page = {
  total: number;
  next: string | null;
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
    // Five products leave some segments without a blob: those count as empty.
    expect(teesSegments.filter((n) => n === 0).length).toBeGreaterThan(0);
    expect((await get('/v1/web/en/categories/tees/products?limit=2')).status).toBe(200);
    const body = await page('/v1/web/en/categories/tees/products?limit=2');
    expect(body).toMatchObject({ total: 5, sorts: ['newest', 'price_asc', 'price_desc'] });
    expect(body.next).toMatch(/^[0-9a-z]+(\.[0-9a-z]+){7}$/);
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
    for (const cursor of [
      '-1',
      '2',
      '0.0.0',
      '0.0.0.0.0.0.0.0.0',
      '0.0.0.0.0.0.0.01',
      '0.0.0.0.0.0.0.A',
    ])
      expect(
        (await get(`/v1/web/en/categories/tees/products?cursor=${cursor}`)).status,
        cursor,
      ).toBe(400);
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
    const first = (await (await get(path)).json()) as Page;
    const next = await get(`${path}&cursor=${first.next}`);
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
    expect((await get('/_idx/web/tees/0')).status).toBe(404);
  });

  it('serves each segment internally, revalidating it with its ETag', async () => {
    const delivery = (exports as unknown as { Delivery: Fetcher }).Delivery;
    const blob = (path: string, init?: RequestInit) =>
      delivery.fetch(`https://catalog.internal/_idx/${path}`, init);
    const s = teesSegments.findIndex((n) => n > 0);
    const r = await blob(`web/tees/${s}`);
    expect(r.status).toBe(200);
    // Its length up front, which the listing-wide cap is checked against before reading.
    const stored = await env.PUBLISHED.head(paths.listing(DOC_FORMAT, 'web', 'tees', s));
    expect(r.headers.get('content-length')).toBe(String(stored?.size));
    await r.arrayBuffer();
    const etag = r.headers.get('etag') ?? '';
    const again = await blob(`web/tees/${s}`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('cache-tag')).toBe('cat:tees,ch:web');
    // An empty segment is a miss, as are a segment out of range and a malformed path.
    const empty = teesSegments.indexOf(0);
    expect((await blob(`web/tees/${empty}`)).status).toBe(404);
    for (const bad of [`web/tees/${LISTING_SEGMENTS}`, 'web/tees/01', 'web/tees', 'web/tees/0/x'])
      expect((await blob(bad)).status, bad).toBe(404);
  });

  // About 200 pages fetched one after another: quick locally, but past the 5s default on a busy CI runner.
  it('merges every segment into one order per sort, paging without skips or repeats', async () => {
    const order = (sort: string, hits: IndexEntry[]) => {
      const newest = (a: IndexEntry, b: IndexEntry) => b.createdAt - a.createdAt || a.uid - b.uid;
      const price = (e: IndexEntry) => e.numbers.price?.[0] as number;
      return [...hits].sort((a, b) =>
        sort === 'newest'
          ? newest(a, b)
          : (sort === 'price_asc' ? price(a) - price(b) : price(b) - price(a)) || newest(a, b),
      );
    };
    for (const [query, hits] of [
      ['', many],
      ['f.brand=acme,hooli', many.filter((e) => e.terms.brand?.[0] !== 'globex')],
      [
        'f.color=red&r.price=300..900',
        many.filter(
          (e) =>
            e.terms.color?.[0] === 'red' &&
            (e.numbers.price?.[0] as number) >= 300 &&
            (e.numbers.price?.[0] as number) <= 900,
        ),
      ],
    ] as const)
      for (const sort of ['newest', 'price_asc', 'price_desc']) {
        const want = order(sort, hits).map((e) => e.key);
        const got: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const body: Page = await page(
            `/v1/web/en/categories/many/products?limit=7&sort=${sort}&${query}${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(body.total).toBe(hits.length);
          got.push(...keys(body));
          cursor = body.next;
          pages++;
        } while (cursor && pages < 100);
        expect(got, `${query} ${sort}`).toEqual(want);
        expect(pages).toBe(Math.ceil(want.length / 7));
      }
    // Facet counts are summed over the segments.
    const body = await page('/v1/web/en/categories/many/products?limit=1');
    expect(body.facets.brand?.values.map((v) => [v.value, v.count])).toEqual([
      ['acme', 100],
      ['globex', 100],
      ['hooli', 100],
    ]);
  }, 30_000);
});

describe('held listing indexes', () => {
  const limits = { ...INDEX_LIMITS };
  afterEach(() => {
    Object.assign(INDEX_LIMITS, limits);
    forgetListings();
  });
  const spec = { terms: ['brand', 'color'], numbers: ['price'], sorts: ['price'] };
  const total = async (category: string) =>
    (await page(`/v1/web/en/categories/${category}/products?limit=1`)).total;
  const heldBytes = () =>
    [...heldListings().listings.values()].flat().reduce((n, h) => n + h.bytes, 0);

  it('holds empty segments too, and asks for none of them again until revalidating', async () => {
    forgetListings();
    const sizes = await publish(
      'small',
      [entry(9001, 'acme', [], 100), entry(9002, 'acme', [], 200)],
      spec,
    );
    expect(await total('small')).toBe(2);
    const first = heldListings().listings.get('web/small') ?? [];
    expect(first.map((h) => h.index !== null)).toEqual(sizes.map((n) => n > 0));
    expect(first.every((h) => h.checked > 0)).toBe(true);
    // A product appears in an empty segment: within the trust window nothing is asked for again,
    // so the held listing is served as it was.
    const empty = sizes.indexOf(0);
    let uid = 9003;
    while (listingSegment(`p${uid}`) !== empty) uid++;
    await publish('small', [entry(uid, 'acme', [], 300)], spec);
    expect(await total('small')).toBe(2);
    // Revalidated, the empty segment is fetched again and found.
    INDEX_LIMITS.trustMs = 0;
    expect(await total('small')).toBe(3);
    expect(heldListings().bytes).toBe(heldBytes());
  });

  it('keeps a listing over the budget whole, evicting other listings, and revalidates it with 304s', async () => {
    forgetListings();
    INDEX_LIMITS.budget = 1;
    expect(await total('tees')).toBe(5);
    expect(await total('many')).toBe(300);
    const { listings, bytes } = heldListings();
    expect([...listings.keys()]).toEqual(['web/many']);
    const kept = listings.get('web/many') ?? [];
    expect(kept.every((h) => h.index !== null)).toBe(true);
    expect(bytes).toBe(heldBytes());
    expect(bytes).toBeGreaterThan(INDEX_LIMITS.budget);
    // Revalidating every segment: each answers 304, so the decoded segments are the same objects.
    INDEX_LIMITS.trustMs = 0;
    expect(await total('many')).toBe(300);
    const again = heldListings().listings.get('web/many') ?? [];
    for (const [s, h] of again.entries()) {
      expect(h.index).toBe(kept[s]?.index);
      expect(h.checked).toBeGreaterThanOrEqual(kept[s]?.checked ?? 0);
    }
    expect(heldListings().bytes).toBe(bytes);
  });

  it('refuses a listing whose segments add up to more than the cap, though each fits', async () => {
    forgetListings();
    const sizes = await Promise.all(
      Array.from(
        { length: LISTING_SEGMENTS },
        async (_, s) =>
          (await env.PUBLISHED.head(paths.listing(DOC_FORMAT, 'web', 'many', s)))?.size ?? 0,
      ),
    );
    const sum = sizes.reduce((a, b) => a + b, 0);
    INDEX_LIMITS.max = sum - 1;
    expect(Math.max(...sizes)).toBeLessThan(INDEX_LIMITS.max);
    const r = await get('/v1/web/en/categories/many/products');
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'listing too large' });
    expect(heldListings().listings.has('web/many')).toBe(false);
    INDEX_LIMITS.max = sum;
    expect(await total('many')).toBe(300);
  });

  it('answers 503 for a listing with a segment in another format until it is rebuilt', async () => {
    const entries = [entry(9101, 'acme', [], 100), entry(9102, 'acme', [], 200)];
    await publish('older', entries, spec);
    const s = listingSegment('p9101');
    const old = buildListingIndex([entries[0] as IndexEntry], spec);
    new DataView(old.buffer, old.byteOffset).setUint32(4, 2, true);
    await env.PUBLISHED.put(paths.listing(DOC_FORMAT, 'web', 'older', s), old);
    const r = await get('/v1/web/en/categories/older/products');
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'listing rebuilding' });
    expect(heldListings().listings.has('web/older')).toBe(false);
    await publish('older', entries, spec);
    forgetListings();
    expect(await total('older')).toBe(2);
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
    // The first page's cursor is the same page; any other keeps its one spelling.
    expect(url('cursor=0.0.0.0.0.0.0.0')).toBe(url(''));
    expect(url('cursor=0.a.0.0.0.0.0.1z')).toBe(
      'https://catalog.internal/v1/web/en/categories/tees/products?cursor=0.a.0.0.0.0.0.1z',
    );
  });
});
