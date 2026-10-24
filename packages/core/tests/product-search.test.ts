import { describe, expect, it } from 'vitest';
import { ftsQuery, normalizeQuery, QUERY_MAX, queryTerms } from '../src/product/search';

describe('search queries', () => {
  it('normalizes case, width, spacing and length into one cache key', () => {
    expect(normalizeQuery('  Blue   COTTON\tTee ')).toBe('blue cotton tee');
    expect(normalizeQuery('ＴＥＥ')).toBe('tee');
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(QUERY_MAX);
  });

  it('quotes every term and prefix-matches the last', () => {
    expect(ftsQuery('blue cott')).toBe('"blue" "cott"*');
    expect(ftsQuery('t-shirt é')).toBe('"t" "shirt" "é"');
    expect(ftsQuery('   ')).toBeNull();
  });

  it('never lets FTS5 syntax through', () => {
    // Operators, column filters, NEAR and quotes are only characters.
    expect(ftsQuery(normalizeQuery('title:"x" OR NEAR(a b) -c*'))).toBe(
      '"title" "x" "or" "near" "a" "b" "c"',
    );
    expect(queryTerms('a b c d e f g h i j k l')).toHaveLength(10);
  });
});
