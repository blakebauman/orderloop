/**
 * Feed parsing. Two formats:
 *
 * - NDJSON: one product per line, exactly the `ProductInput` shape. The complete format.
 * - CSV: one row per variant, rows of one product contiguous (a key that appears again later
 *   replaces the earlier rows). Columns: `key`, `type`, `status`, `brand`, `categories` and
 *   `media` (both `|`-separated), `title:<locale>`, `slug:<locale>`, `description:<locale>`,
 *   `price.<channel>` and `compareAt.<channel>` (decimal, in the channel's currency),
 *   `visible.<channel>`, `sku`, `gtin`, `mpn`, `variantPrice.<channel>`, `weightKg` and
 *   `lengthCm`, `widthCm`, `heightCm` (all three or none), and `attr.<code>` (or
 *   `attr.<code>:<locale>` for localized text). Attribute cells are read according to the
 *   attribute's kind: `|` separates multi_enum values, money is `12.34 USD`, measure is `2.5`.
 *
 * Both parsers stream: memory stays flat however large the feed. Pure.
 */
import { toMinor } from '../money';
import type { AttributeDef, Channel, Json, ProductInput, ProductType, VariantInput } from './model';
import { parseTypeRef } from './model';

/** A CSV record and the byte offset just past it (its line break included). */
export type CsvRecord = { record: string[]; end: number };

/** UTF-8 bytes of the UTF-16 code unit `c` (a surrogate pair counts 4 on its high half). */
const utf8Bytes = (c: number) =>
  c < 0x80
    ? 1
    : c < 0x800
      ? 2
      : c >= 0xd800 && c <= 0xdbff
        ? 4
        : c >= 0xdc00 && c <= 0xdfff
          ? 0
          : 3;

/**
 * RFC 4180 records from a byte stream: quoted fields, `""` escapes, CRLF or LF, a leading BOM.
 * Each record carries the byte offset just past it, counted from `start` (where the stream begins
 * in the file), so a reader can stop after any record and resume there with a range read
 * (stopping early cancels the stream). The
 * feed must be UTF-8: invalid bytes would make the offsets wrong, so they fail the parse.
 */
export async function* csvRecords(
  stream: ReadableStream<Uint8Array>,
  start = 0,
): AsyncGenerator<CsvRecord, void, undefined> {
  // ignoreBOM keeps a BOM as a character, so its three bytes are counted like any other.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let field = '';
  let record: string[] = [];
  let quoted = false;
  // After a closing quote inside a quoted field: the next char decides (`"` escape or end).
  let quoteSeen = false;
  let started = false;
  let pendingCR = false;
  let bytes = start;
  let first = start === 0;
  let finished = false;
  const reader = stream.getReader();
  const endRecord = function* () {
    record.push(field);
    field = '';
    const r = record;
    record = [];
    started = false;
    if (!(r.length === 1 && r[0] === '')) yield { record: r, end: bytes };
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      let text: string;
      try {
        text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      } catch {
        throw new SyntaxError(`the feed is not valid UTF-8 (near byte ${bytes})`);
      }
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes += utf8Bytes(code);
        if (first) {
          first = false;
          if (code === 0xfeff) continue;
        }
        const ch = text[i] as string;
        if (pendingCR) {
          pendingCR = false;
          if (ch === '\n') continue;
        }
        if (quoted) {
          if (quoteSeen) {
            quoteSeen = false;
            if (ch === '"') {
              field += '"';
              continue;
            }
            quoted = false;
            // Fall through: the char after a closing quote is handled as unquoted.
          } else if (ch === '"') {
            quoteSeen = true;
            continue;
          } else {
            field += ch;
            continue;
          }
        }
        if (ch === '"' && !started) {
          quoted = true;
          started = true;
        } else if (ch === ',') {
          record.push(field);
          field = '';
          started = false;
        } else if (ch === '\n' || ch === '\r') {
          if (ch === '\r') {
            pendingCR = true;
            // A CRLF record ends after its LF: count it now, so `end` lands past the line break.
            if (text[i + 1] === '\n') {
              bytes += 1;
              i++;
              pendingCR = false;
            }
          }
          yield* endRecord();
        } else {
          field += ch;
          started = true;
        }
      }
      if (done) break;
    }
    finished = true;
    if (quoted && !quoteSeen) throw new SyntaxError('unterminated quoted field at end of feed');
    if (field !== '' || record.length) yield* endRecord();
  } finally {
    // Stopped early (a chunk is full, or an error): cancel the rest of the stream.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
}

export type NdjsonRecord = { line: number; value?: unknown; error?: string; end: number };

/**
 * Non-empty lines of an NDJSON stream, parsed, with 1-based line numbers (from `firstLine`) and
 * the byte offset just past each line (from `start`).
 */
export async function* ndjsonRecords(
  stream: ReadableStream<Uint8Array>,
  start = 0,
  firstLine = 1,
): AsyncGenerator<NdjsonRecord, void, undefined> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const reader = stream.getReader();
  let buffered = new Uint8Array(0);
  let bufferStart = start;
  let line = firstLine - 1;
  let finished = false;
  const parse = (bytes: Uint8Array, end: number): NdjsonRecord | undefined => {
    line++;
    let text: string;
    try {
      text = decoder.decode(bytes).trim();
    } catch {
      return { line, error: 'not valid UTF-8', end };
    }
    if (!text) return undefined;
    try {
      return { line, value: JSON.parse(text) as unknown, end };
    } catch {
      return { line, error: 'invalid JSON', end };
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value?.length) {
        const joined = new Uint8Array(buffered.length + value.length);
        joined.set(buffered);
        joined.set(value, buffered.length);
        buffered = joined;
      }
      let from = 0;
      let nl = buffered.indexOf(0x0a);
      while (nl >= 0) {
        const r = parse(buffered.subarray(from, nl), bufferStart + nl + 1);
        if (r) yield r;
        from = nl + 1;
        nl = buffered.indexOf(0x0a, from);
      }
      bufferStart += from;
      buffered = buffered.slice(from);
      if (done) break;
    }
    finished = true;
    if (buffered.length) {
      const r = parse(buffered, bufferStart + buffered.length);
      if (r) yield r;
    }
  } finally {
    // Stopped early: cancel the rest of the stream.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
}

export type FeedRow = {
  /** The product's first row (CSV) or its line (NDJSON). */
  row: number;
  /** The product's last row: a resumed read numbers rows from the one after it. */
  last: number;
  product?: ProductInput;
  error?: string;
  /** Byte offset just past the product's last row: where a resumed read starts. */
  end: number;
};

const BOOL: Record<string, boolean> = {
  true: true,
  false: false,
  '1': true,
  '0': false,
  yes: true,
  no: false,
};

/** A CSV cell read as a value of `def`'s kind. Throws with a message on a bad cell. */
export function readCell(def: AttributeDef, cell: string): Json {
  switch (def.kind) {
    case 'text':
    case 'enum':
    case 'ref':
    case 'date':
      return cell;
    case 'number': {
      const n = Number(cell);
      if (!Number.isFinite(n)) throw new Error(`${def.code}: not a number`);
      return n;
    }
    case 'bool': {
      const b = BOOL[cell.toLowerCase()];
      if (b === undefined) throw new Error(`${def.code}: not true/false`);
      return b;
    }
    case 'multi_enum':
      return cell
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'money': {
      const m = /^(-?\d+(?:\.\d+)?)\s*([A-Za-z]{3})$/.exec(cell.trim());
      if (!m) throw new Error(`${def.code}: expected "12.34 USD"`);
      const currency = (m[2] as string).toUpperCase();
      return { amount: toMinor(Number(m[1]), currency), currency };
    }
    case 'measure': {
      const m = /^(-?\d+(?:\.\d+)?)\s*([^\d\s].*)?$/.exec(cell.trim());
      if (!m) throw new Error(`${def.code}: expected a number`);
      return { value: Number(m[1]), unit: m[2]?.trim() || def.unit || '' };
    }
    case 'json':
      try {
        return JSON.parse(cell) as Json;
      } catch {
        throw new Error(`${def.code}: invalid JSON`);
      }
  }
}

const list = (cell: string | undefined) =>
  cell
    ? cell
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** The CSV header's columns, checked: a feed needs `key` and `sku`. */
export function csvHeader(record: string[]): string[] {
  const header = record.map((h) => h.trim());
  if (!header.includes('key') || !header.includes('sku'))
    throw new SyntaxError('CSV feed needs "key" and "sku" columns');
  return header;
}

/**
 * Products from CSV records. Consecutive rows with the same `key` are one product's variants;
 * product-level columns are read from its first row. Without `opts.header` the first record is the
 * header; with it (resuming mid-file), every record is data and rows are numbered from
 * `opts.firstRow`.
 */
export async function* csvProducts(
  records: AsyncIterable<CsvRecord>,
  resolveType: (code: string, version?: number) => ProductType | undefined,
  channels: Map<string, Channel>,
  opts: { header?: string[]; firstRow?: number } = {},
): AsyncGenerator<FeedRow, void, undefined> {
  let header = opts.header;
  let current:
    | { row: number; last: number; product: ProductInput; error?: string; end: number }
    | undefined;
  let row = (opts.firstRow ?? 1) - 1;
  const done = (c: NonNullable<typeof current>): FeedRow =>
    c.error
      ? { row: c.row, last: c.last, error: c.error, end: c.end }
      : { row: c.row, last: c.last, product: c.product, end: c.end };
  for await (const { record, end } of records) {
    row++;
    if (!header) {
      header = csvHeader(record);
      continue;
    }
    const cells: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = record[i]?.trim();
      if (v) cells[h] = v;
    });
    const key = cells.key ?? '';
    if (current && current.product.key !== key) {
      yield done(current);
      current = undefined;
    }
    try {
      const typeRef = cells.type ?? current?.product.type ?? '';
      const ref = parseTypeRef(typeRef);
      const type = resolveType(ref.code, ref.version);
      if (!type) throw new Error(`unknown type ${typeRef || '(none)'}`);
      const defs = new Map(type.attributes.map((a) => [a.code, a]));
      const productAttrs: Record<string, Json> = {};
      const variantAttrs: Record<string, Json> = {};
      const localized: Record<string, Record<string, string>> = {};
      for (const [col, cell] of Object.entries(cells)) {
        if (!col.startsWith('attr.')) continue;
        const [code, locale] = col.slice(5).split(':') as [string, string | undefined];
        const def = defs.get(code);
        if (!def) throw new Error(`${code}: not an attribute of ${type.code}`);
        const target = def.scope === 'variant' ? variantAttrs : productAttrs;
        if (def.localized) {
          if (!locale) throw new Error(`${code}: localized, use attr.${code}:<locale>`);
          const values = localized[code] ?? {};
          values[locale] = cell;
          localized[code] = values;
          target[code] = values;
        } else target[code] = readCell(def, cell);
      }
      const variant: VariantInput = { sku: cells.sku ?? '', attributes: variantAttrs };
      if (cells.gtin) variant.gtin = cells.gtin;
      if (cells.mpn) variant.mpn = cells.mpn;
      if (cells.weightKg) variant.weightKg = Number(cells.weightKg);
      const size = [cells.lengthCm, cells.widthCm, cells.heightCm];
      if (size.some(Boolean)) {
        if (!size.every(Boolean)) throw new Error('lengthCm, widthCm and heightCm go together');
        const [length, width, height] = size.map(Number) as [number, number, number];
        variant.dimensionsCm = { length, width, height };
      }
      for (const [col, cell] of Object.entries(cells)) {
        if (!col.startsWith('variantPrice.')) continue;
        const ch = channels.get(col.slice(13));
        if (!ch) throw new Error(`${col}: unknown channel`);
        variant.prices = variant.prices ?? {};
        variant.prices[ch.code] = {
          amount: toMinor(Number(cell), ch.currency),
          currency: ch.currency,
        };
      }
      if (current) {
        current.product.variants.push(variant);
        current.end = end;
        current.last = row;
        continue;
      }
      const localizedCol = (prefix: string) => {
        const out: Record<string, string> = {};
        for (const [col, cell] of Object.entries(cells))
          if (col.startsWith(`${prefix}:`)) out[col.slice(prefix.length + 1)] = cell;
        return Object.keys(out).length ? out : undefined;
      };
      const product: ProductInput = {
        key,
        type: typeRef,
        title: localizedCol('title') ?? {},
        variants: [variant],
        attributes: productAttrs,
        categories: list(cells.categories),
        media: list(cells.media).map((src) => ({ src })),
        channels: {},
      };
      if (cells.status) product.status = cells.status as ProductInput['status'];
      if (cells.brand) product.brand = cells.brand;
      const slug = localizedCol('slug');
      if (slug) product.slug = slug;
      const description = localizedCol('description');
      if (description) product.description = description;
      for (const ch of channels.values()) {
        const price = cells[`price.${ch.code}`];
        const compareAt = cells[`compareAt.${ch.code}`];
        const visible = cells[`visible.${ch.code}`];
        if (price === undefined && visible === undefined) continue;
        const listing: NonNullable<ProductInput['channels']>[string] = {
          visible: visible === undefined ? true : BOOL[visible.toLowerCase()] === true,
        };
        if (price !== undefined) {
          const n = Number(price);
          if (!Number.isFinite(n)) throw new Error(`price.${ch.code}: not a number`);
          listing.price = { amount: toMinor(n, ch.currency), currency: ch.currency };
        }
        if (compareAt !== undefined)
          listing.compareAt = {
            amount: toMinor(Number(compareAt), ch.currency),
            currency: ch.currency,
          };
        (product.channels as Record<string, typeof listing>)[ch.code] = listing;
      }
      current = { row, last: row, product, end };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (current) {
        current.error ??= `row ${row}: ${message}`;
        current.end = end;
        current.last = row;
      } else
        current = {
          row,
          last: row,
          product: { key, type: '', title: {}, variants: [] },
          error: message,
          end,
        };
    }
  }
  if (current) yield done(current);
}
