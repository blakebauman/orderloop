import { describe, expect, it } from 'vitest';
import { csvHeader, csvProducts, csvRecords, ndjsonRecords } from '../src/product/feed';
import { types, web } from './fixtures/product';

/** A stream that delivers `text` in chunks of `size` bytes, so multi-byte chars split. */
function stream(text: string | Uint8Array, size = 3): ReadableStream<Uint8Array> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
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

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('CSV records', () => {
  it('reads quotes, escaped quotes, newlines in fields, CRLF, a BOM and split UTF-8', async () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\nplain,,é☕\n\n"last"';
    expect((await all(csvRecords(stream(text)))).map((r) => r.record)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['plain', '', 'é☕'],
      ['last'],
    ]);
  });

  it('gives each record the byte offset to resume after it, from any record', async () => {
    const text = '﻿h1,h2\r\n"a\r\nb",é☕😀\r\nc,"d ""q"""\n\ne,f';
    const bytes = utf8(text);
    const records = await all(csvRecords(stream(text)));
    expect(records.map((r) => r.record)).toEqual([
      ['h1', 'h2'],
      ['a\r\nb', 'é☕😀'],
      ['c', 'd "q"'],
      ['e', 'f'],
    ]);
    expect(records.at(-1)?.end).toBe(bytes.length);
    // A range read from `end` yields exactly the records after this one, at the same offsets.
    for (const [i, r] of records.entries())
      expect(await all(csvRecords(stream(bytes.slice(r.end), 2), r.end))).toEqual(
        records.slice(i + 1),
      );
  });

  it('fails on an unterminated quote, and on bytes that are not UTF-8', async () => {
    await expect(all(csvRecords(stream('a,"b\n')))).rejects.toThrow('unterminated');
    await expect(all(csvRecords(stream(new Uint8Array([0x61, 0x2c, 0xff, 0x0a]))))).rejects.toThrow(
      'not valid UTF-8',
    );
  });
});

describe('NDJSON records', () => {
  it('reads one value per line, reports bad lines, and resumes from any offset', async () => {
    const text = '{"a":1}\n\nnope\n{"b":"☕"}';
    const records = await all(ndjsonRecords(stream(text)));
    expect(records).toEqual([
      { line: 1, value: { a: 1 }, end: 8 },
      { line: 3, error: 'invalid JSON', end: 14 },
      { line: 4, value: { b: '☕' }, end: utf8(text).length },
    ]);
    // Resuming after line 1 numbers lines from where it left off.
    expect(await all(ndjsonRecords(stream(utf8(text).slice(8)), 8, 2))).toEqual(records.slice(1));
  });
});

describe('CSV products', () => {
  const channels = new Map([[web.code, web]]);
  const read = (text: string) => all(csvProducts(csvRecords(stream(text, 64)), types, channels));

  it('groups variant rows into products and reads cells by attribute kind', async () => {
    const text = [
      'key,type,title:en,title:fr,brand,categories,price.web,sku,attr.material,attr.tags,attr.weight,attr.care:en,attr.size,attr.color,variantPrice.web',
      'tee,apparel,Tee,T-shirt,Acme,tops|tees,19.99,TEE-S,cotton,eco|sale,180,Wash cold,S,red,',
      'tee,,,,,,,TEE-M,,,,,M,red,22',
      'hat,apparel,Hat,,Acme,hats,9.5,HAT-1,wool,,,,S,blue,',
    ].join('\n');
    const rows = await read(text);
    expect(rows.map((r) => [r.row, r.last])).toEqual([
      [2, 3],
      [4, 4],
    ]);
    // A product ends after its last variant row: resuming there starts at the next product.
    expect(rows.map((r) => r.end)).toEqual([text.indexOf('\nhat') + 1, utf8(text).length]);
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

  it('reads gtin and mpn per variant row', async () => {
    const rows = await read(
      [
        'key,type,title:en,sku,gtin,mpn,attr.size,attr.color',
        'tee,apparel,Tee,TEE-S,036000291452,CT-100-S,S,red',
        'tee,,,TEE-M,,CT-100-M,M,red',
      ].join('\n'),
    );
    expect(rows[0]?.product?.variants).toEqual([
      {
        sku: 'TEE-S',
        gtin: '036000291452',
        mpn: 'CT-100-S',
        attributes: { size: 'S', color: 'red' },
      },
      { sku: 'TEE-M', mpn: 'CT-100-M', attributes: { size: 'M', color: 'red' } },
    ]);
  });

  it('reads shipping weight and size per variant row, size all or nothing', async () => {
    const rows = await read(
      [
        'key,type,title:en,sku,weightKg,lengthCm,widthCm,heightCm,attr.size,attr.color',
        'tee,apparel,Tee,TEE-S,0.25,30,20,2,S,red',
        'tee,,,TEE-M,0.3,,,,M,red',
        'cap,apparel,Cap,CAP-1,,20,,10,S,red',
      ].join('\n'),
    );
    expect(rows[0]?.product?.variants).toEqual([
      {
        sku: 'TEE-S',
        weightKg: 0.25,
        dimensionsCm: { length: 30, width: 20, height: 2 },
        attributes: { size: 'S', color: 'red' },
      },
      { sku: 'TEE-M', weightKg: 0.3, attributes: { size: 'M', color: 'red' } },
    ]);
    expect(rows[1]).toMatchObject({ error: 'lengthCm, widthCm and heightCm go together' });
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
      { row: 2, last: 2, error: 'weight: expected a number', end: expect.any(Number) },
      { row: 3, last: 3, error: 'nope: not an attribute of apparel', end: expect.any(Number) },
      expect.objectContaining({ row: 4 }),
    ]);
  });

  it('resumes mid-file from a product boundary with the header it was given', async () => {
    const lines = [
      'key,type,title:en,sku',
      'a,apparel,A,A1',
      'a,,,A2',
      'b,apparel,B,B1',
      'c,apparel,C,C1',
    ];
    const text = lines.join('\n');
    const first = await read(text);
    const header = csvHeader((lines[0] as string).split(','));
    const from = first[0]?.end ?? 0;
    const resumed = await all(
      csvProducts(csvRecords(stream(utf8(text).slice(from)), from), types, channels, {
        header,
        firstRow: 4,
      }),
    );
    expect(resumed).toEqual(first.slice(1));
  });

  it('needs key and sku columns', async () => {
    await expect(read('name,price\nx,1')).rejects.toThrow('"key" and "sku"');
  });
});
