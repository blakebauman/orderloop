/**
 * The listing index: everything a category page needs, in one binary blob per channel and category.
 * The edge decodes it zero-copy (typed-array views over the fetched bytes), so a listing with
 * filters, facet counts over the whole result set and a sort is a few passes over integer arrays,
 * with no database on the read path. Members are products' numeric uids, not their keys: the page's
 * cards are fetched by uid, so a million-member index carries 4 MB of ids instead of the key text.
 *
 * Members are numbered 0..n-1 newest first, so the default sort needs no permutation. A term value's
 * members are stored as a sorted ordinal list when sparse and as a bitset when dense (more than one
 * in 32). Numeric attributes keep every value per member (CSR layout), so a range filter matches a
 * product when any of its variants' values is in range. Pure.
 */
import type { IndexEntry } from './render';

const MAGIC = 0x314c4f4c; // "LOL1" little-endian
const FORMAT = 1;

export type ListingSpec = {
  /** Term attributes to index (filters and facet counts), including `brand`. */
  terms: string[];
  /** Numeric attributes to index (range filters and buckets), including `price`. */
  numbers: string[];
  /** Numeric attributes offered as sorts (a subset of `numbers`). */
  sorts: string[];
};

type Section = [offset: number, length: number];

type Meta = {
  n: number;
  builtAt: number;
  ids: Section;
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

/** Builds the blob from the index entries of one channel's category. */
export function buildListingIndex(
  entries: IndexEntry[],
  spec: ListingSpec,
  builtAt = Date.now(),
): Uint8Array {
  const members = [...entries].sort((a, b) => b.createdAt - a.createdAt || a.uid - b.uid);
  const n = members.length;
  const chunks: { bytes: Uint8Array; set: (s: Section) => void }[] = [];
  const add = (view: ArrayBufferView, set: (s: Section) => void) =>
    chunks.push({ bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength), set });

  const encoder = new TextEncoder();
  const meta: Meta = { n, builtAt, ids: [0, 0], terms: [], numbers: [] };
  add(
    Uint32Array.from(members, (m) => m.uid),
    (s) => {
      meta.ids = s;
    },
  );

  for (const code of spec.terms) {
    const postings = new Map<string, number[]>();
    members.forEach((m, i) => {
      for (const v of m.terms[code] ?? []) {
        let list = postings.get(v);
        if (!list) {
          list = [];
          postings.set(v, list);
        }
        list.push(i);
      }
    });
    if (!postings.size) continue;
    const facet: Meta['terms'][number] = { code, values: [] };
    const sorted = [...postings].sort(
      (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
    );
    for (const [v, list] of sorted) {
      const bits = list.length * 32 > n;
      const value = { v, count: list.length, bits, at: [0, 0] as Section };
      facet.values.push(value);
      if (bits) {
        const words = new Uint32Array((n + 31) >>> 5);
        for (const i of list) words[i >>> 5] = (words[i >>> 5] as number) | (1 << (i & 31));
        add(words, (s) => {
          value.at = s;
        });
      } else
        add(Uint32Array.from(list), (s) => {
          value.at = s;
        });
    }
    meta.terms.push(facet);
  }

  for (const code of spec.numbers) {
    const offsets = new Uint32Array(n + 1);
    const flat: number[] = [];
    members.forEach((m, i) => {
      for (const v of m.numbers[code] ?? []) flat.push(v);
      offsets[i + 1] = flat.length;
    });
    if (!flat.length) continue;
    const int = flat.every((v) => Number.isInteger(v) && v >= -0x8000_0000 && v <= 0x7fff_ffff);
    const values = int ? Int32Array.from(flat) : Float64Array.from(flat);
    const col: Meta['numbers'][number] = { code, offsets: [0, 0], values: [0, 0], int };
    add(offsets, (s) => {
      col.offsets = s;
    });
    add(values, (s) => {
      col.values = s;
    });
    if (spec.sorts.includes(code)) {
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
      // Members without a value sort last both ways; ties keep newest first.
      const ids = Array.from({ length: n }, (_, i) => i);
      const asc = Uint32Array.from(
        [...ids].sort((a, b) => (lo[a] as number) - (lo[b] as number) || a - b),
      );
      const desc = Uint32Array.from(
        [...ids].sort((a, b) => {
          const x = hi[a] as number;
          const y = hi[b] as number;
          if (x === y) return a - b;
          if (x === Number.NEGATIVE_INFINITY) return 1;
          if (y === Number.NEGATIVE_INFINITY) return -1;
          return y - x;
        }),
      );
      add(asc, (s) => {
        col.asc = s;
      });
      add(desc, (s) => {
        col.desc = s;
      });
    }
    meta.numbers.push(col);
  }

  // Lay out: header (16 bytes), meta JSON, then 8-byte-aligned sections in order.
  let offset = 0;
  const placed = chunks.map((c) => {
    const at = offset;
    offset = align8(offset + c.bytes.byteLength);
    return at;
  });
  // Sections are [byte offset from the data start, byte length].
  chunks.forEach((c, i) => {
    c.set([placed[i] as number, c.bytes.byteLength]);
  });
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const dataStart = align8(16 + metaBytes.byteLength);
  const out = new Uint8Array(dataStart + offset);
  const header = new DataView(out.buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, FORMAT, true);
  header.setUint32(8, metaBytes.byteLength, true);
  header.setUint32(12, dataStart, true);
  out.set(metaBytes, 16);
  chunks.forEach((c, i) => {
    out.set(c.bytes, dataStart + (placed[i] as number));
  });
  return out;
}

export type ListingQuery = {
  /** Term filters: any of the values within an attribute, all attributes together. */
  terms?: Record<string, string[]>;
  /** Range filters, inclusive; either end may be open. */
  ranges?: Record<string, [lo: number | null, hi: number | null]>;
  /** `newest` (default), or `<numeric>_asc` / `<numeric>_desc` for an indexed sort. */
  sort?: string;
  /** Position to continue from (the previous page's `next`). */
  cursor?: number;
  limit: number;
  /** Bucket edges per numeric facet to count, ascending. */
  buckets?: Record<string, number[]>;
};

export type FacetCount = { value: string; count: number };
export type BucketCount = { lo: number | null; hi: number | null; count: number };

export type ListingResult = {
  total: number;
  /** Uids of the page's products, in order. */
  uids: number[];
  next?: number;
  terms: Record<string, FacetCount[]>;
  ranges: Record<string, { min: number; max: number; buckets?: BucketCount[] }>;
};

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** A decoded listing index. Construction is O(meta); arrays are views, not copies. */
export class ListingIndex {
  readonly n: number;
  readonly builtAt: number;
  private readonly words: number;
  private readonly ids: Uint32Array;
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
    this.words = (meta.n + 31) >>> 5;
    this.ids = u32(meta.ids);
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

  /** Sorts this index can serve, besides `newest`. */
  get sorts(): string[] {
    const out: string[] = [];
    for (const [code, c] of this.numCols) if (c.asc) out.push(`${code}_asc`, `${code}_desc`);
    return out;
  }

  /** The uid of member `i`. */
  uid(i: number): number {
    return this.ids[i] as number;
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

  private count(set: Uint32Array): number {
    let c = 0;
    for (let i = 0; i < this.words; i++) c += popcount(set[i] as number);
    return c;
  }

  query(q: ListingQuery): ListingResult {
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

    const terms: ListingResult['terms'] = {};
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
        else if (p.list)
          for (const m of p.list) if (((base[m >>> 5] as number) >>> (m & 31)) & 1) c++;
        if (c) counts.push({ value: p.v, count: c });
      }
      counts.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
      terms[code] = counts;
    }

    const ranges: ListingResult['ranges'] = {};
    for (const [code, col] of this.numCols) {
      const base = without(code);
      const edges = q.buckets?.[code];
      const bucketCounts = edges ? new Array<number>(edges.length + 1).fill(0) : undefined;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < this.n; i++) {
        if (!(((base[i >>> 5] as number) >>> (i & 31)) & 1)) continue;
        const start = col.offsets[i] as number;
        const end = col.offsets[i + 1] as number;
        if (start === end) continue;
        let hit = 0;
        for (let j = start; j < end; j++) {
          const v = col.values[j] as number;
          if (v < min) min = v;
          if (v > max) max = v;
          if (bucketCounts && edges) {
            let b = 0;
            while (b < edges.length && v >= (edges[b] as number)) b++;
            // Count a member once per bucket it has a value in.
            if (!(hit & (1 << b))) {
              hit |= 1 << b;
              bucketCounts[b] = (bucketCounts[b] as number) + 1;
            }
          }
        }
      }
      if (min === Number.POSITIVE_INFINITY) continue;
      ranges[code] = {
        min,
        max,
        buckets:
          edges && bucketCounts
            ? bucketCounts.map((count, b) => ({
                lo: b === 0 ? null : (edges[b - 1] as number),
                hi: b === edges.length ? null : (edges[b] as number),
                count,
              }))
            : undefined,
      };
    }

    let order: Uint32Array | undefined;
    if (q.sort && q.sort !== 'newest') {
      const m = /^(.+)_(asc|desc)$/.exec(q.sort);
      const col = m ? this.numCols.get(m[1] as string) : undefined;
      order = m?.[2] === 'asc' ? col?.asc : col?.desc;
      if (!order) throw new RangeError(`unsupported sort ${q.sort}`);
    }
    const uids: number[] = [];
    let pos = Math.max(0, Math.trunc(q.cursor ?? 0));
    for (; pos < this.n && uids.length < q.limit; pos++) {
      const i = order ? (order[pos] as number) : pos;
      if (((result[i >>> 5] as number) >>> (i & 31)) & 1) uids.push(this.ids[i] as number);
    }
    // Look ahead for one more match, so the last page has no `next`.
    let next: number | undefined;
    for (let p = pos; p < this.n; p++) {
      const i = order ? (order[p] as number) : p;
      if (((result[i >>> 5] as number) >>> (i & 31)) & 1) {
        next = pos;
        break;
      }
    }
    return { total: this.count(result), uids, next, terms, ranges };
  }
}
