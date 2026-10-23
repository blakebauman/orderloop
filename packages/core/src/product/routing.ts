/**
 * Where a product lives. The hash and the shard counts are part of the stored data's layout:
 * changing either moves every product to a different shard, so both are frozen (the golden tests
 * in tests/product-routing.test.ts fail if they change). Pure.
 */

/** Write shards holding products and alias claims. Frozen. */
export const PRODUCT_SHARDS = 64;
/** Keyword search shards. Derived data: changing this needs a search rebuild, nothing more. */
export const SEARCH_SHARDS = 16;

const encoder = new TextEncoder();
let scratch = new Uint8Array(256);

/**
 * 64-bit FNV-1a of the UTF-8 bytes of `s`, as two unsigned 32-bit halves. Computed on halves so a
 * feed split hashing millions of keys never allocates a BigInt.
 */
export function fnv1a64Parts(s: string): [hi: number, lo: number] {
  if (s.length * 3 > scratch.length) scratch = new Uint8Array(s.length * 3);
  const { written } = encoder.encodeInto(s, scratch);
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < written; i++) {
    lo ^= scratch[i] as number;
    // h * 0x100000001b3 mod 2^64 = h * 0x1b3 + (h << 40). Every product below is exact in a double.
    const l = (lo >>> 0) * 0x1b3;
    const carry = Math.floor(l / 0x1_0000_0000);
    const h = (hi >>> 0) * 0x1b3 + carry + ((lo << 8) >>> 0);
    lo = l >>> 0;
    hi = h >>> 0;
  }
  return [hi >>> 0, lo >>> 0];
}

/** 64-bit FNV-1a as 16 lowercase hex digits. */
export function fnv1a64(s: string): string {
  const [hi, lo] = fnv1a64Parts(s);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function mod64(s: string, n: number): number {
  const [hi, lo] = fnv1a64Parts(s);
  // (hi * 2^32 + lo) mod n, with every term below 2^53 for n < 2^20.
  return ((hi % n) * (0x1_0000_0000 % n) + (lo % n)) % n;
}

/** The write shard that owns product `key`. */
export function productShard(key: string): number {
  return mod64(`p:${key}`, PRODUCT_SHARDS);
}

/** The write shard that holds the claim on `alias` (a SKU, GTIN or slug). */
export function aliasShard(alias: string): number {
  return mod64(`a:${alias}`, PRODUCT_SHARDS);
}

/** Products a shard can ever number: uids are `shard * 2^26 + n`, so they fit in 32 bits. */
export const UIDS_PER_SHARD = 2 ** 26;

/** A product's permanent numeric id: its shard and the shard's creation counter. Never reused. */
export function productUid(shard: number, seq: number): number {
  if (!Number.isInteger(seq) || seq < 0 || seq >= UIDS_PER_SHARD)
    throw new RangeError(`shard ${shard} has numbered all ${UIDS_PER_SHARD} products it can`);
  return shard * UIDS_PER_SHARD + seq;
}

/** The search shard indexing product `key`. */
export function searchShard(key: string): number {
  return mod64(`s:${key}`, SEARCH_SHARDS);
}

/**
 * JSON with object keys sorted and `undefined` dropped, so equal data always serializes to equal
 * text. Arrays keep their order: order is meaningful (media, variants).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Fingerprint of a product's data: a re-sent, unchanged row hashes the same and writes nothing. */
export function contentHash(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}
