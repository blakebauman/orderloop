import { describe, expect, it } from 'vitest';
import {
  type CatalogEntry,
  documentPhrases,
  documentSkus,
  documentTerms,
  EXTRACT_CANDIDATES,
  EXTRACT_CATALOG_TOKENS,
  estimateTokens,
  rankExtractCandidates,
} from '../src/extract-catalog';

/** `n` products that share nothing with the documents below. */
const filler = (n: number): CatalogEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    sku: `FIL-${String(i).padStart(5, '0')}`,
    name: `Filler part ${i}`,
  }));

const catalog: CatalogEntry[] = [
  { sku: 'LAP-14', name: 'Laptop 14-inch' },
  { sku: 'MON-27', name: 'Monitor 27-inch 4K' },
  { sku: 'BRG-608', name: 'Bearing 608-2RS' },
  { sku: 'GSK-010', name: 'Gasket kit' },
  { sku: 'CBL-USB', name: 'USB-C cable, braided' },
  ...filler(1_000),
];

const skus = (c: CatalogEntry[]) => c.map((e) => e.sku);
const promptTokens = (c: CatalogEntry[]) => estimateTokens(JSON.stringify(c));

describe('rankExtractCandidates', () => {
  it('puts SKUs the document names first, then names it shares words with', () => {
    const doc = 'PO 4411\n3 x MON-27\nAlso 200 gasket kits please, and two bearings 608-2RS.';
    const out = rankExtractCandidates(doc, catalog);
    expect(out[0]!.sku).toBe('MON-27');
    expect(skus(out)).toContain('GSK-010');
    expect(skus(out)).toContain('BRG-608');
    expect(skus(out)).not.toContain('LAP-14');
    expect(out.some((e) => e.sku.startsWith('FIL-'))).toBe(false);
  });

  it('matches a SKU written without or with spaced separators, and in any case', () => {
    expect(skus(rankExtractCandidates('5 of lap14', catalog))[0]).toBe('LAP-14');
    expect(skus(rankExtractCandidates('5 of LAP 14', catalog))[0]).toBe('LAP-14');
    expect(skus(rankExtractCandidates('5 of lap-14.', catalog))[0]).toBe('LAP-14');
  });

  it('weighs a rare word above one every name shares', () => {
    const pool: CatalogEntry[] = [
      { sku: 'A-1', name: 'Steel bolt M8' },
      { sku: 'B-1', name: 'Steel washer' },
      { sku: 'C-1', name: 'Steel bracket' },
      ...filler(100),
    ];
    expect(skus(rankExtractCandidates('steel washers x 40, steel', pool))[0]).toBe('B-1');
  });

  it('adds semantic matches and ranks them by similarity', () => {
    const out = rankExtractCandidates('ten portable computers for the new hires', catalog, {
      semantic: [
        { sku: 'MON-27', score: 0.41 },
        { sku: 'lap-14', score: 0.83 },
      ],
    });
    expect(skus(out).slice(0, 2)).toEqual(['LAP-14', 'MON-27']);
  });

  it('keeps an exact mention above any semantic match', () => {
    const out = rankExtractCandidates('2 x GSK-010', catalog, {
      semantic: [{ sku: 'LAP-14', score: 0.99 }],
    });
    expect(out[0]!.sku).toBe('GSK-010');
  });

  it('shows a catalog that fits whole, matched entries first', () => {
    const small = catalog.slice(0, 5);
    const out = rankExtractCandidates('2 gasket kits', small);
    expect(out).toHaveLength(5);
    expect(out[0]!.sku).toBe('GSK-010');
  });

  it('caps the other candidates at the limit but keeps every exact mention', () => {
    const many = filler(5_000);
    const named = many.slice(0, 120).map((e) => e.sku);
    const doc = `${named.map((s) => `1 x ${s}`).join('\n')}\nfiller part filler part`;
    const out = rankExtractCandidates(doc, many);
    expect(skus(out).slice(0, 120).sort()).toEqual([...named].sort());
    expect(out).toHaveLength(120 + EXTRACT_CANDIDATES);
  });

  it('stays within the token budget however large the catalog and the document', () => {
    const many = filler(5_000).map((e) => ({ ...e, name: `${e.name} ${'x'.repeat(300)}` }));
    const doc = many.map((e) => e.sku).join(' ');
    const out = rankExtractCandidates(doc, many);
    expect(out.length).toBeGreaterThan(0);
    expect(promptTokens(out)).toBeLessThanOrEqual(EXTRACT_CATALOG_TOKENS);
    expect(out.every((e) => e.name.length <= 120)).toBe(true);
    expect(rankExtractCandidates(doc, many, { tokenBudget: 100 }).length).toBeLessThan(5);
  });

  it('shows nothing from a large catalog the document shares nothing with', () => {
    expect(rankExtractCandidates('hello, any news?', filler(5_000))).toEqual([]);
  });

  it('lists a SKU once when the pool repeats it', () => {
    const out = rankExtractCandidates('LAP-14', [catalog[0]!, { sku: 'lap-14', name: 'Laptop' }]);
    expect(skus(out)).toEqual(['LAP-14']);
  });
});

describe('document parts', () => {
  const doc = 'Hi team,\nPlease send:\n- 3 x MON-27 monitors\n- 2 bearings 608-2RS\nThanks, Ana';

  it('finds code-shaped tokens, as written and upper case', () => {
    expect(documentSkus('3 x mon-27 and 608-2RS, not hello or 42')).toEqual([
      'mon-27',
      'MON-27',
      '608-2RS',
    ]);
    expect(documentSkus('A-1 B-2 C-3', 2)).toHaveLength(2);
  });

  it('takes words from order lines first and leaves out filler words and numbers', () => {
    const terms = documentTerms(doc);
    expect(terms.slice(0, 3)).toEqual(['mon', 'monitors', 'bearings']);
    expect(terms).not.toContain('please');
    expect(terms).not.toContain('27');
    expect(documentTerms(doc, 2)).toHaveLength(2);
  });

  it('embeds order lines first, each once and cut to length', () => {
    expect(documentPhrases(doc)).toEqual([
      '- 3 x MON-27 monitors',
      '- 2 bearings 608-2RS',
      'Hi team,',
      'Please send:',
      'Thanks, Ana',
    ]);
    expect(documentPhrases(`${'a'.repeat(500)}\n${'a'.repeat(500)}`)).toEqual(['a'.repeat(200)]);
  });
});
