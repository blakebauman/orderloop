/**
 * Keyword search queries. What a shopper types becomes one normalized string (the cache key) and
 * then an FTS5 query of quoted terms, all required, the last one also matching as a prefix ("blue
 * cott" finds "blue cotton tee"). User text never reaches FTS5 syntax: every term is quoted, so
 * operators, column filters and stray quotes are just characters. Zod-free, for catalog-edge. Pure.
 */

/** Characters of a query kept, after normalizing. */
export const QUERY_MAX = 100;
/** Terms of a query used; more are dropped. */
export const QUERY_TERMS = 10;
/** Results a search can page through: deeper pages cost every shard more and help nobody. */
export const SEARCH_DEPTH = 1_000;

/** Case-folded, accent-stable, single-spaced and capped: the form a query is cached under. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX).trim();
}

/** The terms of a normalized query: runs of letters and digits, as the index tokenizes them. */
export function queryTerms(normalized: string): string[] {
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, QUERY_TERMS);
}

/** The FTS5 MATCH expression for a normalized query, or null when it has no terms. */
export function ftsQuery(normalized: string): string | null {
  const terms = queryTerms(normalized);
  if (!terms.length) return null;
  return terms
    .map((t, i) => (i === terms.length - 1 && t.length >= 2 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}
