/**
 * The part of the catalog an extract call shows the model. The whole `products` table doesn't fit:
 * the extract model has a 24k-token context, and a few hundred SKUs next to a 20,000-character
 * document overflow it, the call errors and extraction falls back to the regex heuristic. So the
 * document picks its own candidates: SKUs it names outright first, then entries whose SKU or name
 * shares its words, then (where the engine has a product index) entries whose embedding is close
 * to one of its lines. At most EXTRACT_CANDIDATES of those, and never more than
 * EXTRACT_CATALOG_TOKENS of catalog in the prompt.
 *
 * Everything here is pure: the engine fetches the pool (`apps/engine/src/product-index.ts`) and
 * the semantic matches, and this ranks them.
 */

export type CatalogEntry = { sku: string; name: string };
/** A product index hit: the SKU and its cosine similarity to one of the document's lines (0–1). */
export type SemanticMatch = { sku: string; score: number };

/** Candidates beyond the SKUs the document names outright, which are always kept while they fit. */
export const EXTRACT_CANDIDATES = 50;
/**
 * Catalog tokens in an extract prompt. The model's 24k context also holds the document (20,000
 * characters, ~6,700 tokens by `estimateTokens`), the instructions and a 2,048-token answer.
 */
export const EXTRACT_CATALOG_TOKENS = 6_000;
/** A name longer than this is cut: it is there to match against, not to read in full. */
const NAME_MAX = 120;

/** Tokens a model reads for `s`, on the high side: ~3 characters a token for English and codes. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

// Codes keep their inner separators ("LAP-14", "608-2RS", "A/B.1"); words split on everything else.
const CODE = /[\p{L}\p{N}](?:[\p{L}\p{N}._/-]*[\p{L}\p{N}])?/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const compact = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
const STOP = new Set(
  'and are but can for from have her his its our per please qty that the their them they this was were will with would you your need send ship order orders units unit each item items pcs thanks thank regards dear hello best'.split(
    ' ',
  ),
);

/** Lines of the document, those with a number (an order line's quantity) first. */
function orderedLines(text: string): string[] {
  const lines = text
    .split(/[\n;]+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => (l.match(/\p{L}/gu)?.length ?? 0) >= 3);
  return [...lines.filter((l) => /\d/.test(l)), ...lines.filter((l) => !/\d/.test(l))];
}

/**
 * Tokens in the document shaped like product codes (a digit in them), as written and upper case:
 * what the engine looks up by SKU. At most `max`.
 */
export function documentSkus(text: string, max = 300): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CODE)) {
    const t = m[0];
    if (t.length > 64 || !/\d/.test(t) || !/\p{L}|[-_./]/u.test(t)) continue;
    out.add(t);
    out.add(t.toUpperCase());
    if (out.size >= max) break;
  }
  return [...out].slice(0, max);
}

/** Distinct words worth matching names against, from order lines first. At most `max`. */
export function documentTerms(text: string, max = 32): string[] {
  const out = new Set<string>();
  for (const line of orderedLines(text))
    for (const m of line.toLowerCase().matchAll(WORD)) {
      const w = m[0];
      if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue;
      out.add(w);
      if (out.size >= max) return [...out];
    }
  return [...out];
}

/** The document's lines to embed and look up in the product index, order lines first. */
export function documentPhrases(text: string, max = 16): string[] {
  return [...new Set(orderedLines(text).map((l) => l.slice(0, 200)))].slice(0, max);
}

/** A word as names are matched on it: plurals folded ("kits" is "kit"). */
const stem = (w: string) =>
  w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
const wordsOf = (s: string) => new Set([...s.toLowerCase().matchAll(WORD)].map((m) => stem(m[0])));
// A bare number in a name ("Filler part 40") would match any quantity in the document.
const nameWords = (name: string) =>
  [...wordsOf(name)].filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOP.has(w));

/**
 * The entries of `pool` to show the model for `text`, best first: every SKU the document names
 * (exactly, or with its separators dropped or spaced), then up to `limit` more by name overlap
 * (rarer words count more) plus semantic similarity, all within `tokenBudget`. An entry that
 * matches nothing is left out, unless the whole pool fits in `limit`: a small catalog is shown
 * whole, as it always was.
 */
export function rankExtractCandidates(
  text: string,
  pool: readonly CatalogEntry[],
  opts: { semantic?: readonly SemanticMatch[]; limit?: number; tokenBudget?: number } = {},
): CatalogEntry[] {
  const limit = opts.limit ?? EXTRACT_CANDIDATES;
  const budget = opts.tokenBudget ?? EXTRACT_CATALOG_TOKENS;

  const codes = new Set<string>();
  const compacts = new Set<string>();
  let previous = '';
  for (const m of text.matchAll(CODE)) {
    const t = m[0].toUpperCase();
    codes.add(t);
    compacts.add(compact(t));
    // "LAP 14" for LAP-14.
    if (previous) compacts.add(compact(previous + t));
    previous = t;
  }
  const words = wordsOf(text);
  const semantic = new Map<string, number>();
  for (const s of opts.semantic ?? [])
    semantic.set(s.sku.toUpperCase(), Math.max(s.score, semantic.get(s.sku.toUpperCase()) ?? 0));

  const entries = new Map<string, CatalogEntry & { words: string[] }>();
  for (const e of pool) {
    const key = e.sku.toUpperCase();
    if (!entries.has(key)) entries.set(key, { ...e, words: nameWords(e.name) });
  }
  // How many names share each word: "steel" across half the catalog says little; "608-2rs" a lot.
  const df = new Map<string, number>();
  for (const e of entries.values()) for (const w of e.words) df.set(w, (df.get(w) ?? 0) + 1);
  const weight = (w: string) => Math.log(1 + entries.size / (df.get(w) ?? 1));

  const scored = [...entries].map(([key, e]) => {
    const exact = codes.has(key);
    const loose = !exact && key.length >= 3 && compacts.has(compact(key));
    let total = 0;
    let hit = 0;
    for (const w of e.words) {
      total += weight(w);
      if (words.has(w)) hit += weight(w);
    }
    const score =
      (exact ? 1000 : loose ? 500 : 0) +
      (total ? (100 * hit) / total : 0) +
      100 * (semantic.get(key) ?? 0);
    return { entry: { sku: e.sku, name: e.name.slice(0, NAME_MAX) }, exact, score };
  });
  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.sku.localeCompare(b.entry.sku));
  if (entries.size <= limit) ranked.push(...scored.filter((s) => s.score <= 0));

  const out: CatalogEntry[] = [];
  let others = 0;
  let used = 0;
  for (const s of ranked) {
    if (!s.exact && others >= limit) break;
    const cost = estimateTokens(JSON.stringify(s.entry)) + 1;
    if (used + cost > budget) break;
    used += cost;
    out.push(s.entry);
    if (!s.exact) others++;
  }
  return out;
}
