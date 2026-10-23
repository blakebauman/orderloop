/**
 * Feed parsing. Two formats:
 *
 * - NDJSON: one product per line, exactly the `ProductInput` shape. The complete format.
 * - CSV: one row per variant, rows of one product contiguous (a key that appears again later
 *   replaces the earlier rows). Columns: `key`, `type`, `status`, `brand`, `categories` and
 *   `media` (both `|`-separated), `title:<locale>`, `slug:<locale>`, `description:<locale>`,
 *   `price.<channel>` and `compareAt.<channel>` (decimal, in the channel's currency),
 *   `visible.<channel>`, `sku`, `gtin`, `variantPrice.<channel>`, and `attr.<code>` (or
 *   `attr.<code>:<locale>` for localized text). Attribute cells are read according to the
 *   attribute's kind: `|` separates multi_enum values, money is `12.34 USD`, measure is `2.5`.
 *
 * Both parsers stream: memory stays flat however large the feed. Pure.
 */
import { toMinor } from '../money';
import type { AttributeDef, Channel, Json, ProductInput, ProductType, VariantInput } from './model';
import { parseTypeRef } from './model';

/** RFC 4180 records from a byte stream: quoted fields, `""` escapes, CRLF or LF, a leading BOM. */
export async function* csvRecords(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string[], void, undefined> {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  let field = '';
  let record: string[] = [];
  let quoted = false;
  // After a closing quote inside a quoted field: the next char decides (`"` escape or end).
  let quoteSeen = false;
  let started = false;
  let pendingCR = false;
  const reader = stream.getReader();
  const endRecord = function* () {
    record.push(field);
    field = '';
    const r = record;
    record = [];
    started = false;
    if (!(r.length === 1 && r[0] === '')) yield r;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (let i = 0; i < text.length; i++) {
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
          if (ch === '\r') pendingCR = true;
          yield* endRecord();
        } else {
          field += ch;
          started = true;
        }
      }
      if (done) break;
    }
    if (quoted && !quoteSeen) throw new SyntaxError('unterminated quoted field at end of feed');
    if (field !== '' || record.length) yield* endRecord();
  } finally {
    reader.releaseLock();
  }
}

/** Non-empty lines of an NDJSON stream, parsed, with 1-based line numbers. */
export async function* ndjsonRecords(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ line: number; value?: unknown; error?: string }, void, undefined> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = '';
  let line = 0;
  const parse = (text: string) => {
    line++;
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      return { line, value: JSON.parse(trimmed) as unknown };
    } catch {
      return { line, error: 'invalid JSON' };
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const r = parse(buffered.slice(0, nl));
        if (r) yield r;
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf('\n');
      }
      if (done) break;
    }
    const r = parse(buffered);
    if (r) yield r;
  } finally {
    reader.releaseLock();
  }
}

export type FeedRow = { row: number; product?: ProductInput; error?: string };

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

/**
 * Products from CSV records (the first record is the header). Consecutive rows with the same `key`
 * are one product's variants; product-level columns are read from its first row.
 */
export async function* csvProducts(
  records: AsyncIterable<string[]>,
  resolveType: (code: string, version?: number) => ProductType | undefined,
  channels: Map<string, Channel>,
): AsyncGenerator<FeedRow, void, undefined> {
  let header: string[] | undefined;
  let current: { row: number; product: ProductInput; error?: string } | undefined;
  let row = 0;
  for await (const record of records) {
    row++;
    if (!header) {
      header = record.map((h) => h.trim());
      if (!header.includes('key') || !header.includes('sku'))
        throw new SyntaxError('CSV feed needs "key" and "sku" columns');
      continue;
    }
    const cells: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = record[i]?.trim();
      if (v) cells[h] = v;
    });
    const key = cells.key ?? '';
    if (current && current.product.key !== key) {
      yield current.error ? { row: current.row, error: current.error } : current;
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
      current = { row, product };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (current) current.error ??= `row ${row}: ${message}`;
      else current = { row, product: { key, type: '', title: {}, variants: [] }, error: message };
    }
  }
  if (current) yield current.error ? { row: current.row, error: current.error } : current;
}
