import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLORS, feed, key, LEAVES, MATERIALS, TYPE } from './catalog-bench.ts';

test('the benchmark feed is two variant rows a product, seeded, with values its type declares', async () => {
  const text = await new Response(feed(2_500)).text();
  const [header, ...rows] = text.trimEnd().split('\n');
  assert.equal(
    header,
    'key,type,title:en,brand,categories,price.bench,sku,attr.material,attr.color,attr.size',
  );
  assert.equal(rows.length, 5_000);
  const keys = new Set<string>();
  for (let i = 0; i < rows.length; i += 2) {
    // A product row, then its second variant, which names only its key, SKU and size.
    const first = (rows[i] as string).match(
      /^([^,]+),([^,]+),"[^"]+",([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),S$/,
    );
    assert.ok(first, rows[i]);
    const [, k, type, , category, price, sku, material, color] = first;
    assert.equal(k, key(i / 2));
    assert.equal(type, TYPE);
    assert.ok(LEAVES.includes(category as string), category);
    assert.match(price as string, /^\d+\.\d{2}$/);
    assert.equal(sku, `${(k as string).toUpperCase()}-S`);
    assert.ok(MATERIALS.includes(material as string) && COLORS.includes(color as string));
    assert.equal(rows[i + 1], `${k},,,,,,${(k as string).toUpperCase()}-M,,,M`);
    keys.add(k as string);
  }
  assert.equal(keys.size, 2_500);
  // Seeded: the same feed every run, so runs compare.
  assert.equal(await new Response(feed(2_500)).text(), text);
});
