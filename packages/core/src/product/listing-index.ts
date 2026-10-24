/**
 * The listing index: everything a category page needs, in LISTING_SEGMENTS binary blobs per channel
 * and category. A product's key picks its segment (`listingSegment`), and each segment is built by
 * its own indexer, so no one build grows with the whole category. The edge decodes every segment
 * zero-copy (typed-array views over the fetched bytes) and `queryListing` answers over all of them:
 * filters, facet counts over the whole result set and a sort are a few passes over integer arrays,
 * with no database on the read path, and the page is a merge of the segments' sorted orders.
 * Members are products' numeric uids, not their keys: the page's cards are fetched by uid, so a
 * million-member index carries 4 MB of ids instead of the key text.
 *
 * A segment's members are numbered 0..n-1 newest first (`createdAt` descending, then uid), so the
 * default sort needs no permutation; each member's `createdAt` is stored too, so segments merge in
 * that order. A term value's members are stored as a sorted ordinal list when sparse and as a
 * bitset when dense (more than one in 32). Numeric attributes keep every value per member (CSR
 * layout), so a range filter matches a product when any of its variants' values is in range. Pure,
 * and free of zod: catalog-edge imports this module on its own.
 */
import type { IndexEntry } from './render';
import { LISTING_SEGMENTS } from './routing';

export { LISTING_SEGMENTS };

const MAGIC = 0x314c4f4c; // "LOL1" little-endian
/** 2: members' `createdAt` (Float64, member order), for merging segments. */
const FORMAT = 2;

export type ListingSpec = {
  /** Term attributes to index (filters and facet counts), including `brand`. */
  terms: string[];
  /** Numeric attributes to index (range filters and buckets), including `price`. */
  numbers: string[];
  /** Numeric attributes offered as sorts (a subset of `numbers`). */
  sorts: string[];
  /** Range bucket edges per numeric attribute, counted when a query doesn't name its own. */
  buckets?: Record<string, number[]>;
  /** Display labels per locale: attribute names (`attributes`) and term values (`values`). */
  labels?: Record<string, Labels>;
};

export type Labels = {
  attributes: Record<string, string>;
  values: Record<string, Record<string, string>>;
};

type Section = [offset: number, length: number];

type Meta = {
  n: number;
  builtAt: number;
  buckets?: Record<string, number[]>;
  labels?: Record<string, Labels>;
  ids: Section;
  createdAt: Section;
  terms: { code: string; values: { v: string; count: number; bits: boolean; at: Section }[] }[];
  numbers: {
    code: string;
    offsets: Section;
    values: Section;
    /** Values are stored as Int32 when every one fits (money in minor units does), else Float64. */
    int: boolean;
    asc?: Section;
    desc?: Section;
  }[];
};

const align8 = (n: number) => (n + 7) & ~7;

/**
 * Builds a listing index a piece at a time, so a caller can stream a million members out of
 * storage without holding them as objects: give it the member ids in order, then each term value's
 * members and each numeric column, then `finish`. Memory is the output plus the arrays handed in.
 */
export class ListingIndexBuilder {
  private n = 0;
  private readonly chunks: { bytes: Uint8Array; set: (s: Section) => void }[] = [];
  private readonly meta: Meta;
  private readonly facets = new Map<string, Meta['terms'][number]>();

  constructor(
    private readonly spec: ListingSpec,
    builtAt = Date.now(),
  ) {
    this.meta = {
      n: 0,
      builtAt,
      buckets: spec.buckets,
      labels: spec.labels,
      ids: [0, 0],
      createdAt: [0, 0],
      terms: [],
      numbers: [],
    };
  }

  private add(view: ArrayBufferView, set: (s: Section) => void) {
    this.chunks.push({ bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength), set });
  }

  /**
   * The members' uids and creation times, in listing order (`createdAt` descending, then uid):
   * member `i` is `uids[i]`. Call first.
   */
  ids(uids: Uint32Array, createdAt: Float64Array) {
    if (createdAt.length !== uids.length)
      throw new RangeError('a creation time is needed for every member');
    this.n = uids.length;
    this.meta.n = uids.length;
    this.add(uids, (s) => {
      this.meta.ids = s;
    });
    this.add(createdAt, (s) => {
      this.meta.createdAt = s;
    });
  }

  /** The members holding term `value` of `code`, as ascending member numbers. */
  term(code: string, value: string, members: Uint32Array) {
    if (!members.length) return;
    let facet = this.facets.get(code);
    if (!facet) {
      facet = { code, values: [] };
      this.facets.set(code, facet);
    }
    const bits = members.length * 32 > this.n;
    const entry = { v: value, count: members.length, bits, at: [0, 0] as Section };
    facet.values.push(entry);
    const set = (s: Section) => {
      entry.at = s;
    };
    if (!bits) return this.add(members, set);
    const words = new Uint32Array((this.n + 31) >>> 5);
    for (const i of members) words[i >>> 5] = (words[i >>> 5] as number) | (1 << (i & 31));
    this.add(words, set);
  }

  /**
   * A numeric column in CSR form: member `i`'s values are `values[offsets[i]..offsets[i + 1]]`.
   * Sorts are derived here when `spec.sorts` names the column, which is then written even with no
   * values, so every segment built with the spec offers the sort (`listingSorts`).
   */
  numbers(code: string, offsets: Uint32Array, flat: ArrayLike<number>) {
    const n = this.n;
    if (!flat.length && !this.spec.sorts.includes(code)) return;
    let int = true;
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i] as number;
      if (!Number.isInteger(v) || v < -0x8000_0000 || v > 0x7fff_ffff) {
        int = false;
        break;
      }
    }
    const values = int ? Int32Array.from(flat) : Float64Array.from(flat);
    const col: Meta['numbers'][number] = { code, offsets: [0, 0], values: [0, 0], int };
    this.add(offsets, (s) => {
      col.offsets = s;
    });
    this.add(values, (s) => {
      col.values = s;
    });
    if (this.spec.sorts.includes(code)) {
      const lo = new Float64Array(n);
      const hi = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (let j = offsets[i] as number; j < (offsets[i + 1] as number); j++) {
          const v = values[j] as number;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        lo[i] = min;
        hi[i] = max;
      }
      // Members without a value sort last both ways; ties keep newest first. `queryListing`'s
      // merge compares members across segments the same way.
      const asc = new Uint32Array(n);
      const desc = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        asc[i] = i;
        desc[i] = i;
      }
      asc.sort((a, b) => (lo[a] as number) - (lo[b] as number) || a - b);
      desc.sort((a, b) => {
        const x = hi[a] as number;
        const y = hi[b] as number;
        if (x === y) return a - b;
        if (x === Number.NEGATIVE_INFINITY) return 1;
        if (y === Number.NEGATIVE_INFINITY) return -1;
        return y - x;
      });
      this.add(asc, (s) => {
        col.asc = s;
      });
      this.add(desc, (s) => {
        col.desc = s;
      });
    }
    this.meta.numbers.push(col);
  }

  finish(): Uint8Array {
    // Facets in the spec's order, values by count (then name), so the meta reads stably.
    for (const code of this.spec.terms) {
      const facet = this.facets.get(code);
      if (!facet) continue;
      facet.values.sort((a, b) => b.count - a.count || (a.v < b.v ? -1 : 1));
      this.meta.terms.push(facet);
    }
    // Lay out: header (16 bytes), meta JSON, then 8-byte-aligned sections in order.
    let offset = 0;
    const placed = this.chunks.map((c) => {
      const at = offset;
      offset = align8(offset + c.bytes.byteLength);
      return at;
    });
    // Sections are [byte offset from the data start, byte length].
    this.chunks.forEach((c, i) => {
      c.set([placed[i] as number, c.bytes.byteLength]);
    });
    const metaBytes = new TextEncoder().encode(JSON.stringify(this.meta));
    const dataStart = align8(16 + metaBytes.byteLength);
    const out = new Uint8Array(dataStart + offset);
    const header = new DataView(out.buffer);
    header.setUint32(0, MAGIC, true);
    header.setUint32(4, FORMAT, true);
    header.setUint32(8, metaBytes.byteLength, true);
    header.setUint32(12, dataStart, true);
    out.set(metaBytes, 16);
    this.chunks.forEach((c, i) => {
      out.set(c.bytes, dataStart + (placed[i] as number));
    });
    return out;
  }
}

/** Builds a segment's blob from its index entries (one channel's category), all in memory. */
export function buildListingIndex(
  entries: IndexEntry[],
  spec: ListingSpec,
  builtAt = Date.now(),
): Uint8Array {
  const members = [...entries].sort((a, b) => b.createdAt - a.createdAt || a.uid - b.uid);
  const n = members.length;
  const b = new ListingIndexBuilder(spec, builtAt);
  b.ids(
    Uint32Array.from(members, (m) => m.uid),
    Float64Array.from(members, (m) => m.createdAt),
  );
  for (const code of spec.terms) {
    const postings = new Map<string, number[]>();
    members.forEach((m, i) => {
      for (const v of m.terms[code] ?? []) {
        const list = postings.get(v) ?? [];
        list.push(i);
        postings.set(v, list);
      }
    });
    for (const [v, list] of postings) b.term(code, v, Uint32Array.from(list));
  }
  for (const code of spec.numbers) {
    const offsets = new Uint32Array(n + 1);
    const flat: number[] = [];
    members.forEach((m, i) => {
      for (const v of m.numbers[code] ?? []) flat.push(v);
      offsets[i + 1] = flat.length;
    });
    b.numbers(code, offsets, flat);
  }
  return b.finish();
}

export type ListingQuery = {
  /** Term filters: any of the values within an attribute, all attributes together. */
  terms?: Record<string, string[]>;
  /** Range filters, inclusive; either end may be open. */
  ranges?: Record<string, [lo: number | null, hi: number | null]>;
  /** `newest` (default), or `<numeric>_asc` / `<numeric>_desc` for an indexed sort. */
  sort?: string;
  /** Where to continue from (the previous page's `next`); absent for the first page. */
  cursor?: string;
  limit: number;
  /** Bucket edges per numeric facet to count, ascending (default: the ones the index was built with). */
  buckets?: Record<string, number[]>;
};

export type FacetCount = { value: string; count: number };
export type BucketCount = { lo: number | null; hi: number | null; count: number };

export type ListingResult = {
  total: number;
  /** Uids of the page's products, in order. */
  uids: number[];
  /** The cursor of the next page, absent on the last. */
  next?: string;
  terms: Record<string, FacetCount[]>;
  ranges: Record<string, { min: number; max: number; buckets?: BucketCount[] }>;
};

/**
 * A listing cursor: each segment's position in its own order for the query's sort, in base 36,
 * joined by `.` (`0.0.0.0.0.0.0.0` is the first page). Opaque to callers.
 */
export function encodeListingCursor(positions: readonly number[]): string {
  return positions.map((p) => p.toString(36)).join('.');
}

/** No leading zeros, so a position has one spelling and a page one canonical URL. */
const POSITION = /^(0|[1-9a-z][0-9a-z]{0,10})$/;

/**
 * The positions in a cursor, or null unless it is exactly `segments` base-36 non-negative safe
 * integers in canonical form.
 */
export function decodeListingCursor(
  cursor: string,
  segments: number = LISTING_SEGMENTS,
): number[] | null {
  const parts = cursor.split('.');
  if (parts.length !== segments) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!POSITION.test(part)) return null;
    const v = Number.parseInt(part, 36);
    if (!Number.isSafeInteger(v)) return null;
    out.push(v);
  }
  return out;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** One segment's part of a query: its matches, and its facet and range counts before merging. */
type Scan = {
  result: Uint32Array;
  terms: Map<string, FacetCount[]>;
  ranges: Map<string, { min: number; max: number; buckets?: number[] }>;
};

/** A segment's members in a sort's order, and each member's sort value. */
type Sorter = { order: Uint32Array; key: (i: number) => number };

/** A decoded listing index segment. Construction is O(meta); arrays are views, not copies. */
export class ListingIndex {
  readonly n: number;
  readonly builtAt: number;
  /** Labels for a locale, when the index was built with them. */
  readonly labels: Record<string, Labels>;
  /** The bucket edges it was built with, per numeric attribute. */
  readonly buckets: Record<string, number[]>;
  private readonly words: number;
  private readonly ids: Uint32Array;
  private readonly created: Float64Array;
  private readonly termCols = new Map<
    string,
    { v: string; count: number; bits?: Uint32Array; list?: Uint32Array }[]
  >();
  private readonly numCols = new Map<
    string,
    {
      offsets: Uint32Array;
      values: Int32Array | Float64Array;
      asc?: Uint32Array;
      desc?: Uint32Array;
    }
  >();

  constructor(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC) throw new Error('not a listing index');
    if (view.getUint32(4, true) !== FORMAT) throw new Error('unsupported listing index format');
    const metaLen = view.getUint32(8, true);
    const dataStart = view.getUint32(12, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, metaLen))) as Meta;
    const u32 = (s: Section) => new Uint32Array(buffer, dataStart + s[0], s[1] / 4);
    const f64 = (s: Section) => new Float64Array(buffer, dataStart + s[0], s[1] / 8);
    const i32 = (s: Section) => new Int32Array(buffer, dataStart + s[0], s[1] / 4);
    this.n = meta.n;
    this.builtAt = meta.builtAt;
    this.labels = meta.labels ?? {};
    this.buckets = meta.buckets ?? {};
    this.words = (meta.n + 31) >>> 5;
    this.ids = u32(meta.ids);
    this.created = f64(meta.createdAt);
    for (const t of meta.terms)
      this.termCols.set(
        t.code,
        t.values.map((v) =>
          v.bits
            ? { v: v.v, count: v.count, bits: u32(v.at) }
            : { v: v.v, count: v.count, list: u32(v.at) },
        ),
      );
    for (const c of meta.numbers)
      this.numCols.set(c.code, {
        offsets: u32(c.offsets),
        values: c.int ? i32(c.values) : f64(c.values),
        asc: c.asc && u32(c.asc),
        desc: c.desc && u32(c.desc),
      });
  }

  /** Sorts this segment can serve, besides `newest`. */
  get sorts(): string[] {
    const out: string[] = [];
    for (const [code, c] of this.numCols) if (c.asc) out.push(`${code}_asc`, `${code}_desc`);
    return out;
  }

  /** The attributes it has facet values and numbers for, in the spec's order. */
  get attributes(): { terms: string[]; numbers: string[] } {
    return { terms: [...this.termCols.keys()], numbers: [...this.numCols.keys()] };
  }

  /** The uid of member `i`. */
  uid(i: number): number {
    return this.ids[i] as number;
  }

  /** When member `i` was created. */
  createdAt(i: number): number {
    return this.created[i] as number;
  }

  private all(): Uint32Array {
    const w = new Uint32Array(this.words);
    w.fill(0xffffffff);
    const tail = this.n & 31;
    if (tail && this.words) w[this.words - 1] = (1 << tail) - 1;
    return w;
  }

  private termSet(code: string, values: string[]): Uint32Array {
    const out = new Uint32Array(this.words);
    const col = this.termCols.get(code);
    if (!col) return out;
    const wanted = new Set(values);
    for (const p of col) {
      if (!wanted.has(p.v)) continue;
      if (p.bits)
        for (let i = 0; i < this.words; i++) out[i] = (out[i] as number) | (p.bits[i] as number);
      else if (p.list)
        for (const m of p.list) out[m >>> 5] = (out[m >>> 5] as number) | (1 << (m & 31));
    }
    return out;
  }

  private rangeSet(code: string, lo: number | null, hi: number | null): Uint32Array {
    const out = new Uint32Array(this.words);
    const col = this.numCols.get(code);
    if (!col) return out;
    const min = lo ?? Number.NEGATIVE_INFINITY;
    const max = hi ?? Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.n; i++)
      for (let j = col.offsets[i] as number; j < (col.offsets[i + 1] as number); j++) {
        const v = col.values[j] as number;
        if (v >= min && v <= max) {
          out[i >>> 5] = (out[i >>> 5] as number) | (1 << (i & 31));
          break;
        }
      }
    return out;
  }

  private and(sets: Uint32Array[]): Uint32Array {
    const out = this.all();
    for (const s of sets)
      for (let i = 0; i < this.words; i++) out[i] = (out[i] as number) & (s[i] as number);
    return out;
  }

  /** Whether member `i` is in `set`. */
  static has(set: Uint32Array, i: number): boolean {
    return (((set[i >>> 5] as number) >>> (i & 31)) & 1) === 1;
  }

  /**
   * This segment's matches for `q` and its facet and range counts, with bucket `edges` per
   * numeric attribute (the same for every segment, so `queryListing` can add them up).
   */
  scan(q: ListingQuery, edges: Record<string, number[] | undefined>): Scan {
    const filters: { code: string; set: Uint32Array }[] = [];
    for (const [code, values] of Object.entries(q.terms ?? {}))
      if (values.length) filters.push({ code, set: this.termSet(code, values) });
    for (const [code, [lo, hi]] of Object.entries(q.ranges ?? {}))
      if (lo !== null || hi !== null) filters.push({ code, set: this.rangeSet(code, lo, hi) });
    const result = this.and(filters.map((f) => f.set));
    // Disjunctive facets: each attribute counts against the other attributes' filters only, so
    // picking a brand still shows how many products every other brand has.
    const without = (code: string) =>
      filters.some((f) => f.code === code)
        ? this.and(filters.filter((f) => f.code !== code).map((f) => f.set))
        : result;

    const terms: Scan['terms'] = new Map();
    for (const [code, col] of this.termCols) {
      const base = without(code);
      const unfiltered = filters.length === 0;
      const counts: FacetCount[] = [];
      for (const p of col) {
        let c = 0;
        if (unfiltered) c = p.count;
        else if (p.bits)
          for (let i = 0; i < this.words; i++)
            c += popcount((p.bits[i] as number) & (base[i] as number));
        else if (p.list) for (const m of p.list) if (ListingIndex.has(base, m)) c++;
        if (c) counts.push({ value: p.v, count: c });
      }
      terms.set(code, counts);
    }

    const ranges: Scan['ranges'] = new Map();
    for (const [code, col] of this.numCols) {
      const base = without(code);
      const cuts = edges[code];
      const buckets = cuts ? new Array<number>(cuts.length + 1).fill(0) : undefined;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < this.n; i++) {
        if (!ListingIndex.has(base, i)) continue;
        const start = col.offsets[i] as number;
        const end = col.offsets[i + 1] as number;
        if (start === end) continue;
        let hit = 0;
        for (let j = start; j < end; j++) {
          const v = col.values[j] as number;
          if (v < min) min = v;
          if (v > max) max = v;
          if (buckets && cuts) {
            let b = 0;
            while (b < cuts.length && v >= (cuts[b] as number)) b++;
            // Count a member once per bucket it has a value in.
            if (!(hit & (1 << b))) {
              hit |= 1 << b;
              buckets[b] = (buckets[b] as number) + 1;
            }
          }
        }
      }
      if (min !== Number.POSITIVE_INFINITY) ranges.set(code, { min, max, buckets });
    }
    return { result, terms, ranges };
  }

  /**
   * The members in `code`'s order and each member's sort value: its lowest value ascending, its
   * highest descending, and ±Infinity (last either way) without one.
   */
  sorter(code: string, dir: 'asc' | 'desc'): Sorter {
    const col = this.numCols.get(code);
    const order = dir === 'asc' ? col?.asc : col?.desc;
    if (!col || !order) throw new RangeError(`unsupported sort ${code}_${dir}`);
    const { offsets, values } = col;
    return {
      order,
      key: (i) => {
        let k = dir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        for (let j = offsets[i] as number; j < (offsets[i + 1] as number); j++) {
          const v = values[j] as number;
          if (dir === 'asc' ? v < k : v > k) k = v;
        }
        return k;
      },
    };
  }
}

/** Present segments, the most recently built first: its spec (labels, buckets) is the current one. */
function latestFirst(segments: readonly (ListingIndex | null)[]): ListingIndex[] {
  return segments
    .filter((s): s is ListingIndex => s !== null)
    .sort((a, b) => b.builtAt - a.builtAt);
}

/** Codes from every list, once each, in the order first seen. */
function union(lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

/**
 * Sorts a listing can serve, besides `newest`: those every segment it has offers. A segment not yet
 * rebuilt since a sort was added has no order for it, and would put its members last.
 */
export function listingSorts(segments: readonly (ListingIndex | null)[]): string[] {
  const [latest, ...rest] = latestFirst(segments);
  return (latest?.sorts ?? []).filter((sort) => rest.every((s) => s.sorts.includes(sort)));
}

/** A listing's labels per locale, from its most recently built segment. */
export function listingLabels(segments: readonly (ListingIndex | null)[]): Record<string, Labels> {
  return latestFirst(segments)[0]?.labels ?? {};
}

/**
 * Answers `q` over a listing's segments (`null` for a segment that holds no members): totals and
 * facet counts summed, ranges spanning every segment, and the page merged from the segments' own
 * orders. The merge orders members by the sort's value, then newest first, then by uid, which is
 * each segment's order too, so a page is exactly the next `limit` members of the whole listing in
 * that order, and the cursor (each segment's position) never skips or repeats one.
 */
export function queryListing(
  segments: readonly (ListingIndex | null)[],
  q: ListingQuery,
): ListingResult {
  const present = latestFirst(segments);
  const start =
    q.cursor === undefined
      ? new Array<number>(segments.length).fill(0)
      : decodeListingCursor(q.cursor, segments.length);
  if (!start) throw new RangeError('bad cursor');
  let sort: { code: string; dir: 'asc' | 'desc' } | undefined;
  if (q.sort && q.sort !== 'newest') {
    const m = /^(.+)_(asc|desc)$/.exec(q.sort);
    if (!m || !listingSorts(segments).includes(q.sort))
      throw new RangeError(`unsupported sort ${q.sort}`);
    sort = { code: m[1] as string, dir: m[2] as 'asc' | 'desc' };
  }
  const numbers = union(present.map((s) => s.attributes.numbers));
  const edges: Record<string, number[] | undefined> = {};
  for (const code of numbers) edges[code] = q.buckets?.[code] ?? present[0]?.buckets[code];
  const scans = segments.map((s) => (s ? s.scan(q, edges) : null));

  let total = 0;
  for (const [i, s] of segments.entries()) {
    const scan = scans[i];
    if (!s || !scan) continue;
    for (let w = 0; w < scan.result.length; w++) total += popcount(scan.result[w] as number);
  }

  const terms: ListingResult['terms'] = {};
  for (const code of union(present.map((s) => s.attributes.terms))) {
    const sums = new Map<string, number>();
    for (const scan of scans)
      for (const c of scan?.terms.get(code) ?? [])
        sums.set(c.value, (sums.get(c.value) ?? 0) + c.count);
    terms[code] = [...sums]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  }

  const ranges: ListingResult['ranges'] = {};
  for (const code of numbers) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const cuts = edges[code];
    const counts = cuts ? new Array<number>(cuts.length + 1).fill(0) : undefined;
    for (const scan of scans) {
      const r = scan?.ranges.get(code);
      if (!r) continue;
      min = Math.min(min, r.min);
      max = Math.max(max, r.max);
      if (counts && r.buckets)
        for (const [b, c] of r.buckets.entries()) counts[b] = (counts[b] as number) + c;
    }
    if (min === Number.POSITIVE_INFINITY) continue;
    ranges[code] = {
      min,
      max,
      buckets:
        cuts && counts
          ? counts.map((count, b) => ({
              lo: b === 0 ? null : (cuts[b - 1] as number),
              hi: b === cuts.length ? null : (cuts[b] as number),
              count,
            }))
          : undefined,
    };
  }

  // The page: a k-way merge of each segment's next match in the sort's order.
  const heads = segments.map((s, i) => {
    const sorter = s && sort ? s.sorter(sort.code, sort.dir) : undefined;
    return {
      segment: s,
      result: scans[i]?.result,
      sorter,
      n: s?.n ?? 0,
      pos: Math.min(start[i] as number, s?.n ?? 0),
      key: 0,
      created: 0,
      uid: 0,
    };
  });
  type Head = (typeof heads)[number];
  /** Moves `h` to its next match at or after `h.pos`, or to the end. */
  const advance = (h: Head) => {
    const { segment, result, sorter } = h;
    if (!segment || !result) return;
    for (; h.pos < h.n; h.pos++) {
      const i = sorter ? (sorter.order[h.pos] as number) : h.pos;
      if (!ListingIndex.has(result, i)) continue;
      h.key = sorter ? sorter.key(i) : 0;
      h.created = segment.createdAt(i);
      h.uid = segment.uid(i);
      return;
    }
  };
  /** Whether `a` comes before `b`: by the sort's value, then newest first, then by uid. */
  const before = (a: Head, b: Head) => {
    if (sort && a.key !== b.key) return sort.dir === 'asc' ? a.key < b.key : a.key > b.key;
    if (a.created !== b.created) return a.created > b.created;
    return a.uid < b.uid;
  };
  for (const h of heads) advance(h);
  const uids: number[] = [];
  while (uids.length < q.limit) {
    let best: Head | undefined;
    for (const h of heads) if (h.pos < h.n && (!best || before(h, best))) best = h;
    if (!best) break;
    uids.push(best.uid);
    best.pos++;
    advance(best);
  }
  const more = heads.some((h) => h.pos < h.n);
  return {
    total,
    uids,
    next: more ? encodeListingCursor(heads.map((h) => h.pos)) : undefined,
    terms,
    ranges,
  };
}
