import { describe, expect, it } from 'vitest';
import {
  buildListingIndex,
  decodeListingCursor,
  encodeListingCursor,
  LISTING_MAX_BYTES,
  LISTING_SEGMENTS,
  ListingIndex,
  ListingIndexBuilder,
  type ListingQuery,
  listingLabels,
  listingSecond,
  listingSorts,
  queryListing,
} from '../src/product/listing-index';
import { listingSpec } from '../src/product/listing-spec';
import type { IndexEntry } from '../src/product/render';
import { listingSegment } from '../src/product/routing';

const spec = { terms: ['brand', 'color'], numbers: ['price'], sorts: ['price'] };

/** A seeded generator, so a failure reproduces. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * A deterministic pseudo-random catalog. Creation times and prices are coarse, so many members
 * tie on them and the tie-breaks (newest first, then uid) are exercised across segments; the
 * milliseconds within a second are random, and the index orders by the second alone. `single`
 * gives every product at most one price (a column stored without offsets).
 */
function catalog(n: number, seed = 7, single = false): IndexEntry[] {
  const rand = random(seed);
  const brands = ['acme', 'globex', 'initech', 'umbrella', 'hooli'];
  const colors = ['red', 'blue', 'green', 'black'];
  return Array.from({ length: n }, (_, i): IndexEntry => {
    const prices = Array.from(
      { length: single ? 1 : 1 + Math.floor(rand() * 3) },
      () => Math.round(rand() * 100) * 100,
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
      createdAt: Math.floor(rand() * 400) * 1_000 + Math.floor(rand() * 1_000),
    };
  });
}

const decode = (bytes: Uint8Array) =>
  new ListingIndex(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );

/** The entries split by key into LISTING_SEGMENTS segments, as the indexers build them. */
function segmented(
  entries: IndexEntry[],
  s: Parameters<typeof buildListingIndex>[1] = spec,
  builtAt = 42,
): (ListingIndex | null)[] {
  const parts: IndexEntry[][] = Array.from({ length: LISTING_SEGMENTS }, () => []);
  for (const e of entries) parts[listingSegment(e.key)]?.push(e);
  return parts.map((p) => (p.length ? decode(buildListingIndex(p, s, builtAt)) : null));
}

/** The same query, answered the slow obvious way over the whole listing. */
function oracle(entries: IndexEntry[], q: ListingQuery, edges?: number[]) {
  const order = [...entries].sort(
    (a, b) => listingSecond(b.createdAt) - listingSecond(a.createdAt) || a.uid - b.uid,
  );
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
  // The price range and buckets count against every filter but price's own.
  const priced = order.filter((e) => matchTerms(e) && matchRanges(e, 'price'));
  const values = priced.flatMap((e) => e.numbers.price ?? []);
  const bucket = (v: number) => (edges ?? []).filter((edge) => v >= edge).length;
  const buckets = edges
    ? Array.from(
        { length: edges.length + 1 },
        (_, b) => priced.filter((e) => (e.numbers.price ?? []).some((v) => bucket(v) === b)).length,
      )
    : undefined;
  const price = values.length
    ? { min: Math.min(...values), max: Math.max(...values), buckets }
    : undefined;
  let sorted = hits;
  if (q.sort === 'price_asc' || q.sort === 'price_desc') {
    const idx = new Map(order.map((e, i) => [e.uid, i]));
    const lo = (e: IndexEntry) => Math.min(...(e.numbers.price ?? [Number.POSITIVE_INFINITY]));
    const hi = (e: IndexEntry) =>
      e.numbers.price?.length ? Math.max(...e.numbers.price) : Number.NEGATIVE_INFINITY;
    const tie = (a: IndexEntry, b: IndexEntry) =>
      (idx.get(a.uid) as number) - (idx.get(b.uid) as number);
    sorted = [...hits].sort((a, b) =>
      q.sort === 'price_asc'
        ? lo(a) === lo(b)
          ? tie(a, b)
          : lo(a) - lo(b)
        : hi(a) === hi(b)
          ? tie(a, b)
          : hi(a) === Number.NEGATIVE_INFINITY
            ? 1
            : hi(b) === Number.NEGATIVE_INFINITY
              ? -1
              : hi(b) - hi(a),
    );
  }
  return { total: hits.length, uids: sorted.map((e) => e.uid), counts, price };
}

/** Every page of `q`, following `next` until it is absent. */
function pages(segments: (ListingIndex | null)[], q: ListingQuery) {
  const got: number[] = [];
  let cursor: string | undefined;
  let n = 0;
  do {
    const page = queryListing(segments, { ...q, cursor });
    expect(page.uids.length).toBeLessThanOrEqual(q.limit);
    got.push(...page.uids);
    cursor = page.next;
    n++;
    if (cursor) expect(page.uids.length).toBe(q.limit);
  } while (cursor !== undefined && n < 10_000);
  return { got, pages: n };
}

describe('listing index segments', () => {
  const entries = catalog(3_000);
  const segments = segmented(entries);

  it('spreads a listing over every segment and round-trips ids and creation times', () => {
    expect(segments.every((s) => s !== null)).toBe(true);
    expect(segments.reduce((n, s) => n + (s?.n ?? 0), 0)).toBe(3_000);
    const created = new Map(entries.map((e) => [e.uid, e.createdAt]));
    const seen = new Set<number>();
    for (const s of segments) {
      if (!s) continue;
      expect(s.builtAt).toBe(42);
      expect(s.sorts).toEqual(['price_asc', 'price_desc']);
      for (let i = 0; i < s.n; i++) {
        seen.add(s.uid(i));
        expect(s.createdAt(i)).toBe(listingSecond(created.get(s.uid(i)) as number));
        // Newest first, then by uid.
        if (i)
          expect(
            s.createdAt(i - 1) > s.createdAt(i) ||
              (s.createdAt(i - 1) === s.createdAt(i) && s.uid(i - 1) < s.uid(i)),
          ).toBe(true);
      }
    }
    expect(seen.size).toBe(3_000);
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
      const got = queryListing(segments, q);
      const want = oracle(entries, q);
      expect(got.total).toBe(want.total);
      expect(got.uids).toEqual(want.uids.slice(0, q.limit));
      for (const code of spec.terms)
        expect(Object.fromEntries((got.terms[code] ?? []).map((f) => [f.value, f.count]))).toEqual(
          want.counts[code],
        );
    });

  const singles = catalog(3_000, 11, true);
  const singleSegments = segmented(singles);

  it.each([
    ['several prices a product', entries, segments],
    ['one price a product', singles, singleSegments],
  ] as const)(
    'pages through random queries exactly in the oracle order (%s)',
    (_, entries, segments) => {
      const rand = random(99);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
      const sorts = ['newest', 'price_asc', 'price_desc'];
      // Pages of 8 to 60: every page reruns the facets over all 3,000 entries, so tiny pages over
      // wide results would take seconds; one-per-page paging has its own test below.
      for (let run = 0; run < 50; run++) {
        const q: ListingQuery = { limit: 8 + Math.floor(rand() * 53), sort: pick(sorts) };
        if (rand() < 0.5)
          q.terms = {
            brand: ['acme', 'globex', 'initech', 'umbrella', 'hooli'].filter(() => rand() < 0.4),
          };
        if (rand() < 0.4)
          q.terms = { ...q.terms, color: [pick(['red', 'blue', 'green', 'black'])] };
        if (rand() < 0.5) {
          const lo = rand() < 0.3 ? null : Math.round(rand() * 50) * 100;
          const hi = rand() < 0.3 ? null : (lo ?? 0) + Math.round(rand() * 60) * 100;
          q.ranges = { price: [lo, hi] };
        }
        const edges = rand() < 0.5 ? [2_500, 5_000, 7_500] : undefined;
        if (edges) q.buckets = { price: edges };
        const want = oracle(entries, q, edges);
        const first = queryListing(segments, q);
        expect(first.total).toBe(want.total);
        for (const code of spec.terms)
          expect(
            Object.fromEntries((first.terms[code] ?? []).map((f) => [f.value, f.count])),
          ).toEqual(want.counts[code]);
        // Facet values most frequent first, then by value.
        for (const counts of Object.values(first.terms))
          for (let i = 1; i < counts.length; i++) {
            const [a, b] = [counts[i - 1], counts[i]] as [
              { value: string; count: number },
              { value: string; count: number },
            ];
            expect(a.count > b.count || (a.count === b.count && a.value < b.value)).toBe(true);
          }
        if (want.price)
          expect(first.ranges.price).toEqual({
            min: want.price.min,
            max: want.price.max,
            buckets: want.price.buckets?.map((count, b) => ({
              lo: b === 0 ? null : (edges?.[b - 1] as number),
              hi: b === edges?.length ? null : (edges?.[b] as number),
              count,
            })),
          });
        else expect(first.ranges.price).toBeUndefined();
        const { got, pages: n } = pages(segments, q);
        expect(new Set(got).size).toBe(got.length);
        expect(got).toEqual(want.uids);
        expect(n).toBe(Math.max(1, Math.ceil(want.uids.length / q.limit)));
      }
    },
    30_000,
  );

  it('pages one member at a time without skipping or repeating', () => {
    for (const sort of ['newest', 'price_asc', 'price_desc']) {
      const q: ListingQuery = { terms: { brand: ['hooli'], color: ['red'] }, sort, limit: 1 };
      const want = oracle(entries, q, undefined);
      const { got, pages: n } = pages(segments, q);
      expect(got).toEqual(want.uids);
      expect(n).toBe(Math.max(1, want.uids.length));
    }
  });

  it('counts range buckets and reports the min and max', () => {
    const r = queryListing(segments, { limit: 0, buckets: { price: [1_000, 5_000] } });
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

  it('rejects a sort no segment has, a bad cursor, garbage bytes and another format', () => {
    expect(() => queryListing(segments, { limit: 1, sort: 'weight_asc' })).toThrow(
      'unsupported sort',
    );
    expect(() => queryListing(segments, { limit: 1, cursor: '0.0' })).toThrow('bad cursor');
    expect(() => new ListingIndex(new ArrayBuffer(32))).toThrow('not a listing index');
    const old = buildListingIndex(entries.slice(0, 10), spec);
    new DataView(old.buffer, old.byteOffset).setUint32(4, 1, true);
    expect(() => decode(old)).toThrow('unsupported listing index format');
  });

  it('handles an empty category, and segments with no members', () => {
    const none = Array.from({ length: LISTING_SEGMENTS }, () => null);
    expect(queryListing(none, { limit: 10 })).toEqual({
      total: 0,
      uids: [],
      next: undefined,
      terms: {},
      ranges: {},
    });
    const empty = buildListingIndex([], spec);
    expect(queryListing([decode(empty)], { limit: 10 })).toEqual({
      total: 0,
      uids: [],
      next: undefined,
      terms: {},
      ranges: {},
    });
    // Three products leave most segments empty.
    const few = catalog(3, 11);
    const sparse = segmented(few);
    expect(sparse.filter((s) => s === null).length).toBeGreaterThan(0);
    const r = queryListing(sparse, { limit: 2 });
    expect(r.total).toBe(3);
    expect(r.uids).toEqual(oracle(few, { limit: 2 }).uids.slice(0, 2));
    const rest = queryListing(sparse, { limit: 2, cursor: r.next });
    expect(rest.uids).toEqual(oracle(few, { limit: 2 }).uids.slice(2));
    expect(rest.next).toBeUndefined();
  });

  it('sorts by a value some segments have no values for, those members last', () => {
    // Only the products in segment 0 have prices; every other segment's price column is empty,
    // but still there, so the listing still offers the sort.
    const mixed = entries.map((e) =>
      listingSegment(e.key) === 0 ? e : { ...e, numbers: {} as Record<string, number[]> },
    );
    const parts = segmented(mixed);
    expect(parts[1]?.sorts).toEqual(['price_asc', 'price_desc']);
    expect(listingSorts(parts)).toEqual(['price_asc', 'price_desc']);
    for (const sort of ['price_asc', 'price_desc']) {
      const q = { limit: 37, sort };
      expect(pages(parts, q).got).toEqual(oracle(mixed, q).uids);
    }
  });

  it('offers a sort only when every segment it has can serve it', () => {
    // Segment 1 was built before price became a sort (not rebuilt since): no listing sort by price,
    // which would otherwise put its priced members last.
    const parts = [...segments];
    const older = entries.filter((e) => listingSegment(e.key) === 1);
    parts[1] = decode(buildListingIndex(older, { ...spec, sorts: [] }, 41));
    expect(parts[1].sorts).toEqual([]);
    expect(listingSorts(parts)).toEqual([]);
    expect(() => queryListing(parts, { limit: 1, sort: 'price_asc' })).toThrow('unsupported sort');
    // A missing segment doesn't count against a sort.
    parts[1] = null;
    expect(listingSorts(parts)).toEqual(['price_asc', 'price_desc']);
  });

  it('takes labels and default buckets from the most recently built segment', () => {
    const few = catalog(200);
    const parts: (ListingIndex | null)[] = Array.from({ length: LISTING_SEGMENTS }, () => null);
    const bySegment = (n: number) => few.filter((e) => listingSegment(e.key) === n);
    parts[0] = decode(
      buildListingIndex(bySegment(0), { ...spec, buckets: { price: [1_000] } }, 100),
    );
    parts[1] = decode(
      buildListingIndex(
        bySegment(1),
        {
          ...spec,
          buckets: { price: [5_000] },
          labels: { en: { attributes: { brand: 'Brand' }, values: {} } },
        },
        200,
      ),
    );
    expect(listingLabels(parts).en?.attributes.brand).toBe('Brand');
    const r = queryListing(parts, { limit: 0 });
    expect(r.ranges.price?.buckets?.map((b) => [b.lo, b.hi])).toEqual([
      [null, 5_000],
      [5_000, null],
    ]);
    // Counted with those edges in both segments.
    const want = oracle([...bySegment(0), ...bySegment(1)], { limit: 0 }, [5_000]);
    expect(r.ranges.price?.buckets?.map((b) => b.count)).toEqual(want.price?.buckets);
  });
});

describe('listing index size', () => {
  const meta = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + view.getUint32(8, true))));
  };
  const one = (uid: number, numbers: Record<string, number[]>): IndexEntry => ({
    key: `p${uid}`,
    uid,
    version: 1,
    categories: ['all'],
    terms: {},
    numbers,
    createdAt: uid * 1_000,
  });
  const s = { terms: [], numbers: ['price', 'weight'], sorts: ['price'] };

  it("keeps each member's distinct values only", () => {
    const repeated = [one(1, { price: [500, 500, 900, 500] }), one(2, { price: [300] })];
    const distinct = [one(1, { price: [900, 500] }), one(2, { price: [300] })];
    expect(buildListingIndex(repeated, s, 1)).toEqual(buildListingIndex(distinct, s, 1));
  });

  it('stores a column no member has two values in without offsets, missing values included', () => {
    const entries = [
      one(1, { price: [500], weight: [1.5] }),
      one(2, { price: [500, 500] }),
      one(3, { weight: [0.25] }),
      one(4, {}),
    ];
    const bytes = buildListingIndex(entries, s, 1);
    const cols = meta(bytes).numbers as { code: string; offsets?: unknown; int: boolean }[];
    expect(cols.map((c) => [c.code, c.offsets === undefined, c.int])).toEqual([
      ['price', true, true],
      ['weight', true, false],
    ]);
    const index = decode(bytes);
    const uids = (q: Omit<ListingQuery, 'limit'>) =>
      queryListing([index], { ...q, limit: 10 }).uids;
    expect(uids({ ranges: { weight: [0, 1] } })).toEqual([3]);
    expect(uids({ ranges: { weight: [null, null] }, sort: 'price_asc' })).toEqual([2, 1, 4, 3]);
    expect(uids({ sort: 'price_desc' })).toEqual([2, 1, 4, 3]);
    expect(uids({ ranges: { price: [400, 600] } })).toEqual([2, 1]);
    const r = queryListing([index], { limit: 0 });
    expect(r.ranges).toEqual({
      price: { min: 500, max: 500, buckets: undefined },
      weight: { min: 0.25, max: 1.5, buckets: undefined },
    });
  });

  it('reads -2^31 in a Float64 single-value column as a value, not a missing one', () => {
    const entries = [one(1, { weight: [1.5] }), one(2, { weight: [-0x8000_0000] }), one(3, {})];
    const index = decode(buildListingIndex(entries, { ...s, sorts: ['weight'] }, 1));
    const uids = (q: Omit<ListingQuery, 'limit'>) =>
      queryListing([index], { ...q, limit: 10 }).uids;
    expect(uids({ ranges: { weight: [null, 0] } })).toEqual([2]);
    expect(uids({ sort: 'weight_asc' })).toEqual([2, 1, 3]);
    expect(queryListing([index], { limit: 0 }).ranges.weight).toMatchObject({
      min: -0x8000_0000,
      max: 1.5,
    });
  });

  it('refuses members out of listing order', () => {
    const b = new ListingIndexBuilder(s);
    expect(() => b.ids(Uint32Array.of(1, 2), [1_000, 2_000])).toThrow('newest first');
    expect(() => b.ids(Uint32Array.of(2, 1), [1_500, 1_000])).toThrow('newest first');
    expect(() => b.ids(Uint32Array.of(1, 2), [1_999, 1_000])).not.toThrow();
  });

  it('costs about 40 bytes a typical member, so a category of 1.5 million fits the cap', () => {
    // Four facets (a sparse brand, a few colors, sizes on every product, a material), a price
    // on three variants that mostly share it, a sorted price and a single weight.
    const rand = random(5);
    const n = 20_000;
    const entries = Array.from({ length: n }, (_, i): IndexEntry => {
      const price = 100 + Math.floor(rand() * 20_000);
      return {
        key: `p${i}`,
        uid: i + 1,
        version: 1,
        categories: ['all'],
        terms: {
          brand: [`b${Math.floor(rand() * 400)}`],
          color: [`c${Math.floor(rand() * 12)}`],
          size: ['S', 'M', 'L'],
          material: [`m${Math.floor(rand() * 30)}`],
        },
        numbers: {
          price: rand() < 0.7 ? [price, price, price] : [price, price + 200, price + 400],
          weight: [Math.floor(rand() * 5_000)],
        },
        createdAt: 1.7e12 + Math.floor(rand() * 3e10),
      };
    });
    const typical = {
      terms: ['brand', 'color', 'size', 'material'],
      numbers: ['price', 'weight'],
      sorts: ['price'],
    };
    const perMember = buildListingIndex(entries, typical).byteLength / n;
    expect(perMember).toBeLessThan(42);
    expect(LISTING_MAX_BYTES / perMember).toBeGreaterThan(1_500_000);
  });
});

describe('listing cursors', () => {
  it('encodes each segment position in base 36 and decodes it back', () => {
    const positions = [0, 1, 35, 36, 1_000_000, 0, 7, Number.MAX_SAFE_INTEGER];
    const c = encodeListingCursor(positions);
    expect(c).toBe(`0.1.z.10.lfls.0.7.${Number.MAX_SAFE_INTEGER.toString(36)}`);
    expect(decodeListingCursor(c)).toEqual(positions);
    expect(decodeListingCursor('0.0.0.0.0.0.0.0')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('accepts only LISTING_SEGMENTS canonical, non-negative, safe base-36 integers', () => {
    for (const bad of [
      '',
      '0',
      '0.0.0.0.0.0.0',
      '0.0.0.0.0.0.0.0.0',
      '0.0.0.0.0.0.0.-1',
      '0.0.0.0.0.0.0.01',
      '0.0.0.0.0.0.0.A',
      '0.0.0.0.0.0.0. 1',
      '0.0.0.0.0.0.0.1.',
      '0.0.0.0.0.0.0.1_0',
      `0.0.0.0.0.0.0.${(Number.MAX_SAFE_INTEGER + 1).toString(36)}`,
      `0.0.0.0.0.0.0.${'z'.repeat(12)}`,
      '24',
    ])
      expect(decodeListingCursor(bad), bad).toBeNull();
    expect(decodeListingCursor('0.1', 2)).toEqual([0, 1]);
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
    const r = queryListing([index], { limit: 0 });
    expect(r.ranges.price?.buckets?.map((b) => [b.lo, b.hi])).toEqual([
      [null, 5_000],
      [5_000, null],
    ]);
  });
});
