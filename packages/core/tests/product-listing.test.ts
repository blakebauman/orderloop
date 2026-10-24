import { describe, expect, it } from 'vitest';
import { buildListingIndex, ListingIndex, type ListingQuery } from '../src/product/listing-index';
import { listingSpec } from '../src/product/listing-spec';
import type { IndexEntry } from '../src/product/render';

const spec = { terms: ['brand', 'color'], numbers: ['price'], sorts: ['price'] };

/** A deterministic pseudo-random catalog. */
function catalog(n: number, seed = 7): IndexEntry[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const brands = ['acme', 'globex', 'initech', 'umbrella', 'hooli'];
  const colors = ['red', 'blue', 'green', 'black'];
  return Array.from({ length: n }, (_, i): IndexEntry => {
    const prices = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
      Math.round(rand() * 10_000),
    );
    const c = colors.filter(() => rand() < 0.4);
    return {
      key: `p${i}`,
      uid: i * 3 + 1,
      version: 1,
      categories: ['all'],
      // Skewed: acme is dense (bitset), the rest sparse (lists).
      terms: {
        brand: [rand() < 0.6 ? 'acme' : (brands[1 + Math.floor(rand() * 4)] as string)],
        color: c,
      },
      numbers: rand() < 0.05 ? {} : { price: prices },
      createdAt: Math.floor(rand() * 1e6),
    };
  });
}

/** The same query, answered the slow obvious way. */
function oracle(entries: IndexEntry[], q: ListingQuery) {
  const order = [...entries].sort((a, b) => b.createdAt - a.createdAt || a.uid - b.uid);
  const matchTerms = (e: IndexEntry, skip?: string) =>
    Object.entries(q.terms ?? {}).every(
      ([code, vals]) =>
        code === skip || !vals.length || (e.terms[code] ?? []).some((v) => vals.includes(v)),
    );
  const matchRanges = (e: IndexEntry, skip?: string) =>
    Object.entries(q.ranges ?? {}).every(
      ([code, [lo, hi]]) =>
        code === skip ||
        (lo === null && hi === null) ||
        (e.numbers[code] ?? []).some((v) => (lo === null || v >= lo) && (hi === null || v <= hi)),
    );
  const hits = order.filter((e) => matchTerms(e) && matchRanges(e));
  const counts: Record<string, Record<string, number>> = {};
  for (const code of spec.terms) {
    counts[code] = {};
    for (const e of order)
      if (matchTerms(e, code) && matchRanges(e))
        for (const v of e.terms[code] ?? []) counts[code][v] = (counts[code][v] ?? 0) + 1;
  }
  let sorted = hits;
  if (q.sort === 'price_asc' || q.sort === 'price_desc') {
    const idx = new Map(order.map((e, i) => [e.uid, i]));
    const lo = (e: IndexEntry) => Math.min(...(e.numbers.price ?? [Number.POSITIVE_INFINITY]));
    const hi = (e: IndexEntry) =>
      e.numbers.price?.length ? Math.max(...e.numbers.price) : Number.NEGATIVE_INFINITY;
    sorted = [...hits].sort((a, b) =>
      q.sort === 'price_asc'
        ? lo(a) - lo(b) || (idx.get(a.uid) as number) - (idx.get(b.uid) as number)
        : hi(a) === hi(b)
          ? (idx.get(a.uid) as number) - (idx.get(b.uid) as number)
          : hi(a) === Number.NEGATIVE_INFINITY
            ? 1
            : hi(b) === Number.NEGATIVE_INFINITY
              ? -1
              : hi(b) - hi(a),
    );
  }
  return { total: hits.length, uids: sorted.map((e) => e.uid), counts };
}

describe('listing index', () => {
  const entries = catalog(3_000);
  const bytes = buildListingIndex(entries, spec, 42);
  const index = new ListingIndex(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );

  it('round-trips ids and metadata', () => {
    expect(index.n).toBe(3_000);
    expect(index.builtAt).toBe(42);
    expect(index.sorts).toEqual(['price_asc', 'price_desc']);
    const all = new Set(Array.from({ length: index.n }, (_, i) => index.uid(i)));
    expect(all.size).toBe(3_000);
  });

  const queries: [string, ListingQuery][] = [
    ['everything', { limit: 3_000 }],
    ['a dense brand', { terms: { brand: ['acme'] }, limit: 3_000 }],
    [
      'two sparse brands and a color',
      { terms: { brand: ['globex', 'hooli'], color: ['red'] }, limit: 3_000 },
    ],
    ['a price range', { ranges: { price: [2_000, 4_000] }, limit: 3_000, sort: 'price_asc' }],
    [
      'filters, open range, descending',
      {
        terms: { color: ['blue', 'black'] },
        ranges: { price: [null, 5_000] },
        limit: 3_000,
        sort: 'price_desc',
      },
    ],
    ['nothing matches', { terms: { brand: ['nobody'] }, limit: 10 }],
  ];
  for (const [name, q] of queries)
    it(`matches the oracle: ${name}`, () => {
      const got = index.query(q);
      const want = oracle(entries, q);
      expect(got.total).toBe(want.total);
      expect(got.uids).toEqual(want.uids.slice(0, q.limit));
      for (const code of spec.terms)
        expect(Object.fromEntries((got.terms[code] ?? []).map((f) => [f.value, f.count]))).toEqual(
          want.counts[code],
        );
    });

  it('pages with a cursor until there is no next', () => {
    const q: ListingQuery = { terms: { color: ['green'] }, limit: 97, sort: 'price_asc' };
    const want = oracle(entries, q).uids;
    const got: number[] = [];
    let cursor: number | undefined = 0;
    let pages = 0;
    while (cursor !== undefined) {
      const page = index.query({ ...q, cursor });
      got.push(...page.uids);
      cursor = page.next;
      pages++;
    }
    expect(got).toEqual(want);
    expect(pages).toBe(Math.ceil(want.length / 97));
  });

  it('counts range buckets and reports the min and max', () => {
    const r = index.query({ limit: 0, buckets: { price: [1_000, 5_000] } });
    const prices = entries.filter((e) => e.numbers.price?.length);
    const inBucket = (lo: number, hi: number) =>
      prices.filter((e) => (e.numbers.price ?? []).some((v) => v >= lo && v < hi)).length;
    expect(r.ranges.price?.buckets).toEqual([
      { lo: null, hi: 1_000, count: inBucket(-Infinity, 1_000) },
      { lo: 1_000, hi: 5_000, count: inBucket(1_000, 5_000) },
      { lo: 5_000, hi: null, count: inBucket(5_000, Infinity) },
    ]);
    const all = prices.flatMap((e) => e.numbers.price ?? []);
    expect(r.ranges.price?.min).toBe(Math.min(...all));
    expect(r.ranges.price?.max).toBe(Math.max(...all));
  });

  it('rejects a sort it does not have, and garbage bytes', () => {
    expect(() => index.query({ limit: 1, sort: 'weight_asc' })).toThrow('unsupported sort');
    expect(() => new ListingIndex(new ArrayBuffer(32))).toThrow('not a listing index');
  });

  it('handles an empty category', () => {
    const empty = buildListingIndex([], spec);
    const r = new ListingIndex(empty.buffer as ArrayBuffer).query({ limit: 10 });
    expect(r).toEqual({ total: 0, uids: [], next: undefined, terms: {}, ranges: {} });
  });
});

describe('listing spec', () => {
  it('indexes filterable terms and numbers, sorts, buckets and labels from the types', async () => {
    const { apparel, web } = await import('./fixtures/product');
    const spec = listingSpec([apparel], web);
    expect(spec.terms).toEqual(['brand', 'material', 'tags', 'size', 'color']);
    expect(spec.numbers).toEqual(['price', 'weight']);
    expect(spec.sorts).toEqual(['price', 'weight']);
    expect(spec.buckets).toEqual({ weight: [200, 500] });
    expect(spec.labels?.fr?.values.material).toEqual({ cotton: 'Coton' });
    expect(spec.labels?.en?.values.color).toEqual({ red: 'Red' });
  });

  it('keeps buckets and labels in the blob and counts the stored buckets by default', () => {
    const entries = catalog(200);
    const bytes = buildListingIndex(entries, {
      ...spec,
      buckets: { price: [5_000] },
      labels: { en: { attributes: { brand: 'Brand' }, values: { color: { red: 'Red' } } } },
    });
    const index = new ListingIndex(bytes.buffer as ArrayBuffer);
    expect(index.labels.en?.values.color).toEqual({ red: 'Red' });
    const r = index.query({ limit: 0 });
    expect(r.ranges.price?.buckets?.map((b) => [b.lo, b.hi])).toEqual([
      [null, 5_000],
      [5_000, null],
    ]);
  });
});
