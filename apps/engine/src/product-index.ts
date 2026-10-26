/**
 * The catalog an `ai.extract` step shows the model, and the product index behind it.
 *
 * `extractCatalog` fetches a pool from `products` for one document (the SKUs it names, the names
 * that share its words, and, with the index bound, the SKUs whose embedding is close to one of its
 * lines) and ranks it with core's `rankExtractCandidates`, so the prompt stays within the model's
 * context however large the catalog. A catalog that fits whole is shown whole.
 *
 * The index (Vectorize, PRODUCT_VECTORS) holds one vector per SKU, its id the SKU, embedded from
 * the SKU and name. `products` has several writers outside the engine (the catalog's listing
 * changes, seeds, the demo reset), so rather than hook each one, `reindexProducts` diffs
 * `products` against `product_vectors` (what the index holds) on the hourly cron: new and renamed
 * SKUs are embedded and upserted, SKUs that are gone are deleted. Every write is keyed by SKU, so
 * a run cut short repeats harmlessly. Until a SKU is indexed it is still found by its words. An
 * admin can run it now too (`EngineRpc.reindexProducts`, the Commerce page); a run holds a lease
 * (`product_index_lease`), so the cron and that never overlap.
 *
 * The binding is optional: without it (tests, local dev, a demo, a deployment not yet
 * provisioned), or in mock AI mode, extraction ranks by words alone and the reindex does nothing.
 */

import {
  documentPhrases,
  documentSkus,
  documentTerms,
  EXTRACT_CANDIDATES,
  type ProductReindex,
  rankExtractCandidates,
  type SemanticMatch,
} from '@orderloop/core';
import { createDb, products, productVectors } from '@orderloop/db';
import { inArray, sql } from 'drizzle-orm';
import { gatewayOptions, NO_LOG_PAYLOAD, withTimeout } from './ai';

/** 768 dimensions, cosine: the index is created with these (scripts/provision.sh). */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
/** Texts per embedding call (the model's batch limit) and per Vectorize write. */
const EMBED_BATCH = 100;
/**
 * SKUs a reindex run embeds. Its calls share the AI Gateway's rate limit (120 a minute) with
 * order steps, so a run takes 30 and a large catalog's first backfill spreads over hours.
 */
export const REINDEX_PER_RUN = 30 * EMBED_BATCH;
/** Matches per document line from the index. */
const MATCHES_PER_LINE = 10;
/** Pool rows from the name search. */
const NAME_POOL = 500;
/** Bound parameters per D1 query stay under its limit of 100. */
const IN_CHUNK = 90;

const db = (env: Env) => createDb(env.DB);
const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The index, when it is bound and models are live. */
function productIndex(env: Env): VectorizeIndex | undefined {
  if (String(env.AI_MODE) === 'mock') return undefined;
  return (env as { PRODUCT_VECTORS?: VectorizeIndex }).PRODUCT_VECTORS;
}

async function embed(env: Env, text: string[]): Promise<number[][]> {
  const res = (await withTimeout(
    env.AI.run(
      EMBEDDING_MODEL,
      // cls pooling: more accurate than the default mean, and not comparable with it, so every
      // vector in the index and every query must use it.
      { text, pooling: 'cls' } as never,
      gatewayOptions(env)
        ? { gateway: gatewayOptions(env), extraHeaders: NO_LOG_PAYLOAD }
        : undefined,
    ),
    20_000,
  )) as { data?: number[][] };
  if (!Array.isArray(res.data) || res.data.length !== text.length)
    throw new Error('embedding response has the wrong shape');
  return res.data;
}

const log = (line: Record<string, unknown>) =>
  console.log(JSON.stringify({ type: 'product_index', ...line }));

/** SKUs whose embedding is close to one of the document's lines; none without the index. */
export async function semanticMatches(env: Env, text: string): Promise<SemanticMatch[]> {
  const index = productIndex(env);
  const phrases = documentPhrases(text);
  if (!index || !phrases.length) return [];
  try {
    const vectors = await embed(env, phrases);
    const results = await Promise.all(
      vectors.map((v) => index.query(v, { topK: MATCHES_PER_LINE })),
    );
    const best = new Map<string, number>();
    for (const r of results)
      for (const m of r.matches) best.set(m.id, Math.max(m.score, best.get(m.id) ?? -1));
    return [...best].map(([sku, score]) => ({ sku, score }));
  } catch (err) {
    // The words still find what the document names; the index only adds what it means.
    console.warn(
      JSON.stringify({
        type: 'product_index',
        op: 'query',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
}

/**
 * The catalog entries to show the model for `text`: the whole catalog when it fits, otherwise the
 * best of what the document's SKUs, words and (with the index) lines find.
 */
export async function extractCatalog(env: Env, text: string) {
  const head = await db(env)
    .select({ sku: products.sku, name: products.name })
    .from(products)
    .limit(EXTRACT_CANDIDATES + 1);
  if (head.length <= EXTRACT_CANDIDATES) return rankExtractCandidates(text, head);

  const semantic = await semanticMatches(env, text);
  const skus = [...new Set([...documentSkus(text), ...semantic.map((s) => s.sku)])];
  const bySku = await Promise.all(
    chunks(skus, IN_CHUNK).map((c) =>
      db(env)
        .select({ sku: products.sku, name: products.name })
        .from(products)
        .where(inArray(products.sku, c)),
    ),
  );
  // Names sharing the most of the document's words, counted in SQL: one scan, the top rows back.
  const terms = documentTerms(text);
  const byName = terms.length
    ? (
        await env.DB.prepare(
          `SELECT sku, name FROM products WHERE ${terms.map((_, i) => `name LIKE ?${i + 1}`).join(' OR ')}
           ORDER BY ${terms.map((_, i) => `(name LIKE ?${i + 1})`).join(' + ')} DESC LIMIT ${NAME_POOL}`,
        )
          .bind(...terms.map((t) => `%${t}%`))
          .all<{ sku: string; name: string }>()
      ).results
    : [];
  // An index hit for a SKU no longer in `products` finds no row here, so it drops out.
  const pool = [...bySku.flat(), ...byName];
  const candidates = rankExtractCandidates(text, pool, { semantic });
  log({
    op: 'extract',
    pool: pool.length,
    semantic: semantic.length,
    candidates: candidates.length,
  });
  return candidates;
}

/**
 * How long a run's lease lasts: a cron invocation's whole wall time, so a run that is still going
 * keeps it, and one that died frees it by the next hour's.
 */
const LEASE_MS = 15 * 60_000;

/**
 * Takes the reindex lease for `holder`, or answers false while another run's is unexpired. One
 * statement, so two runs starting together can't both take it.
 */
async function takeLease(env: Env, holder: string, now: number) {
  const row = await env.DB.prepare(
    `INSERT INTO product_index_lease (id, holder, expires_at) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
     WHERE product_index_lease.expires_at <= ?3
     RETURNING holder`,
  )
    .bind(holder, now + LEASE_MS, now)
    .first<{ holder: string }>();
  return row?.holder === holder;
}

/**
 * Brings the index up to date with `products`, at most `max` SKUs embedded a run: new and renamed
 * ones are upserted (id = SKU), and the vectors of SKUs no longer in `products` deleted. The
 * vector is written before `product_vectors` records it, so a run that stops between the two
 * writes it again next time. `more` says there was more to embed than one run takes.
 *
 * Only one run at a time (`busy` otherwise): two would each embed the same SKUs against the
 * gateway's rate limit, and a run that read a name before a rename could write its vector after
 * one that read it after, leaving the old name's vector recorded as the new one's.
 */
export async function reindexProducts(env: Env, max = REINDEX_PER_RUN): Promise<ProductReindex> {
  const index = productIndex(env);
  if (!index) return { status: 'no_index' };
  const holder = crypto.randomUUID();
  if (!(await takeLease(env, holder, Date.now()))) {
    log({ op: 'reindex', busy: true });
    return { status: 'busy' };
  }
  try {
    const result = await reindex(env, index, max);
    log({ op: 'reindex', ...result });
    return { status: 'done', ...result };
  } finally {
    await env.DB.prepare('DELETE FROM product_index_lease WHERE id = 1 AND holder = ?')
      .bind(holder)
      .run();
  }
}

async function reindex(env: Env, index: VectorizeIndex, max: number) {
  // A Vectorize id is at most 64 bytes; a longer SKU is left to the word search.
  const changed = (
    await env.DB.prepare(
      `SELECT p.sku AS sku, p.name AS name FROM products p
       LEFT JOIN product_vectors v ON v.sku = p.sku
       WHERE (v.sku IS NULL OR v.name <> p.name) AND length(CAST(p.sku AS BLOB)) <= 64
       ORDER BY p.sku LIMIT ?`,
    )
      .bind(max)
      .all<{ sku: string; name: string }>()
  ).results;
  for (const batch of chunks(changed, EMBED_BATCH)) {
    const values = await embed(
      env,
      batch.map((p) => `${p.sku} ${p.name}`),
    );
    await index.upsert(
      batch.map((p, i) => ({
        id: p.sku,
        values: values[i]!,
        metadata: { name: p.name.slice(0, 200) },
      })),
    );
    const at = Date.now();
    const d = db(env);
    const [first, ...rest] = batch.map((p) =>
      d
        .insert(productVectors)
        .values({ sku: p.sku, name: p.name, indexedAt: at })
        .onConflictDoUpdate({
          target: productVectors.sku,
          set: { name: p.name, indexedAt: at },
        }),
    );
    if (first) await d.batch([first, ...rest]);
  }

  const gone = (
    await db(env)
      .select({ sku: productVectors.sku })
      .from(productVectors)
      .where(sql`${productVectors.sku} NOT IN (SELECT ${products.sku} FROM ${products})`)
      .limit(max)
  ).map((r) => r.sku);
  for (const batch of chunks(gone, IN_CHUNK)) {
    await index.deleteByIds(batch);
    await db(env).delete(productVectors).where(inArray(productVectors.sku, batch));
  }
  return { indexed: changed.length, removed: gone.length, more: changed.length === max };
}
