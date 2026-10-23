import { describe, expect, it } from 'vitest';
import { csvProducts, csvRecords, ndjsonRecords } from '../src/product/feed';
import { types, web } from './fixtures/product';

/** A stream that delivers `text` in chunks of `size` bytes, so multi-byte chars split. */
function stream(text: string, size = 3): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('CSV records', () => {
  it('reads quotes, escaped quotes, newlines in fields, CRLF, a BOM and split UTF-8', async () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\nplain,,é☕\n\n"last"';
    expect(await all(csvRecords(stream(text)))).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['plain', '', 'é☕'],
      ['last'],
    ]);
  });

  it('fails on an unterminated quote', async () => {
    await expect(all(csvRecords(stream('a,"b\n')))).rejects.toThrow('unterminated');
  });
});

describe('NDJSON records', () => {
  it('reads one value per line and reports bad lines', async () => {
    expect(await all(ndjsonRecords(stream('{"a":1}\n\nnope\n{"b":"☕"}')))).toEqual([
      { line: 1, value: { a: 1 } },
      { line: 3, error: 'invalid JSON' },
      { line: 4, value: { b: '☕' } },
    ]);
  });
});

describe('CSV products', () => {
  const channels = new Map([[web.code, web]]);
  const read = (text: string) => all(csvProducts(csvRecords(stream(text, 64)), types, channels));

  it('groups variant rows into products and reads cells by attribute kind', async () => {
    const rows = await read(
      [
        'key,type,title:en,title:fr,brand,categories,price.web,sku,attr.material,attr.tags,attr.weight,attr.care:en,attr.size,attr.color,variantPrice.web',
        'tee,apparel,Tee,T-shirt,Acme,tops|tees,19.99,TEE-S,cotton,eco|sale,180,Wash cold,S,red,',
        'tee,,,,,,,TEE-M,,,,,M,red,22',
        'hat,apparel,Hat,,Acme,hats,9.5,HAT-1,wool,,,,S,blue,',
      ].join('\n'),
    );
    expect(rows.map((r) => r.row)).toEqual([2, 4]);
    expect(rows[0]?.product).toEqual({
      key: 'tee',
      type: 'apparel',
      title: { en: 'Tee', fr: 'T-shirt' },
      brand: 'Acme',
      categories: ['tops', 'tees'],
      media: [],
      attributes: {
        material: 'cotton',
        tags: ['eco', 'sale'],
        weight: { value: 180, unit: 'g' },
        care: { en: 'Wash cold' },
      },
      variants: [
        { sku: 'TEE-S', attributes: { size: 'S', color: 'red' } },
        {
          sku: 'TEE-M',
          attributes: { size: 'M', color: 'red' },
          prices: { web: { amount: 2200, currency: 'USD' } },
        },
      ],
      channels: { web: { visible: true, price: { amount: 1999, currency: 'USD' } } },
    });
    expect(rows[1]?.product?.channels).toEqual({
      web: { visible: true, price: { amount: 950, currency: 'USD' } },
    });
  });

  it('reports a bad row against its product and keeps going', async () => {
    const rows = await read(
      [
        'key,type,title:en,sku,attr.weight,attr.nope',
        'a,apparel,A,A1,heavy,',
        'b,apparel,B,B1,,x',
        'c,apparel,C,C1,1,',
      ].join('\n'),
    );
    expect(rows).toEqual([
      { row: 2, error: 'weight: expected a number' },
      { row: 3, error: 'nope: not an attribute of apparel' },
      expect.objectContaining({ row: 4 }),
    ]);
  });

  it('needs key and sku columns', async () => {
    await expect(read('name,price\nx,1')).rejects.toThrow('"key" and "sku"');
  });
});
