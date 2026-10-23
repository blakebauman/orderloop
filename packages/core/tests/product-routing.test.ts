import { describe, expect, it } from 'vitest';
import {
  aliasShard,
  canonicalJson,
  contentHash,
  fnv1a64,
  PRODUCT_SHARDS,
  productShard,
  productUid,
  SEARCH_SHARDS,
  searchShard,
  UIDS_PER_SHARD,
} from '../src/product/routing';

describe('product routing', () => {
  it('is FNV-1a 64 (published test vectors, and a BigInt reference for UTF-8)', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
    expect(fnv1a64('café-☕')).toBe('77e21d7632593219');
  });

  // Frozen: every stored product lives on the shard these functions name. If this test fails,
  // the change would strand every product in production. Don't update the expected values.
  it('keeps every key on the shard it has always had', () => {
    expect(PRODUCT_SHARDS).toBe(64);
    expect(SEARCH_SHARDS).toBe(16);
    const placed = ['WIDGET-001', 'tee-classic', 'sku-42', 'X'].map((k) => [
      productShard(k),
      aliasShard(`sku:${k}`),
      searchShard(k),
    ]);
    expect(placed).toEqual([
      [45, 53, 6],
      [54, 62, 11],
      [25, 1, 6],
      [53, 29, 0],
    ]);
  });

  it('numbers products into 32 bits per shard, and refuses to overflow', () => {
    expect(productUid(0, 0)).toBe(0);
    expect(productUid(63, UIDS_PER_SHARD - 1)).toBe(2 ** 32 - 1);
    expect(() => productUid(1, UIDS_PER_SHARD)).toThrow(RangeError);
  });

  it('spreads keys evenly', () => {
    const counts = new Array<number>(PRODUCT_SHARDS).fill(0);
    const n = 64_000;
    for (let i = 0; i < n; i++) {
      const shard = productShard(`SKU-${i}`);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    for (const c of counts)
      expect(Math.abs(c - n / PRODUCT_SHARDS)).toBeLessThan(n / PRODUCT_SHARDS / 8);
  });

  it('hashes content regardless of key order, and notices any change', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1, b: 2 })).not.toBe(contentHash({ a: 1, b: 3 }));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });
});
