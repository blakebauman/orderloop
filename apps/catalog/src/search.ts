/**
 * Keyword search: 16 SearchShard Durable Objects (core's searchShard), each with one FTS5 table per
 * channel and locale over the published title, brand, SKUs and searchable text. They are fed by
 * the same listing changes as the indexers (latest by `at`, removals tombstoned), and ranked with
 * BM25 weighted towards the title, then SKUs, then brand.
 *
 * SearchApi (an RPC entrypoint for catalog-edge) asks every shard for its best `offset + limit`
 * matches in parallel and merges them by score, so a page costs one round of 16 small queries.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import {
  ftsQuery,
  normalizeQuery,
  SEARCH_DEPTH,
  SEARCH_SHARDS,
  type SearchEntry,
  searchShard,
} from '@orderloop/core/product';
import { searcher } from './config';
import type { ListingChange } from './listings';

/** BM25 column weights: title, brand, skus, body. */
const WEIGHTS = '10.0, 3.0, 8.0, 1.0';
const TOMBSTONE_MS = 24 * 60 * 60 * 1000;

type Item = {
  key: string;
  channel: string;
  at: number;
  uid: number;
  docs: (SearchEntry & { locale: string })[] | null;
};

export type SearchHits = { total: number; hits: { uid: number; score: number }[] };

/** Routes the search half of a batch of changes to the shards, one call per shard. */
export async function applySearch(env: Env, changes: ListingChange[]): Promise<void> {
  const byShard = new Map<number, Item[]>();
  for (const c of changes) {
    const n = searchShard(c.key);
    const list = byShard.get(n) ?? [];
    list.push({ key: c.key, channel: c.channel, at: c.at, uid: c.entry?.uid ?? 0, docs: c.search });
    byShard.set(n, list);
  }
  await Promise.all([...byShard].map(([n, items]) => searcher(env, n).apply(items)));
}

/** An FTS table name for a channel and locale (both already limited to safe characters). */
const table = (channel: string, locale: string) =>
  `fts_${channel.replace(/[^A-Za-z0-9]/g, '_')}__${locale.replace(/[^A-Za-z0-9]/g, '_')}`;

export class SearchShard extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly tables = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (key TEXT NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (key, channel));
      CREATE TABLE IF NOT EXISTS rows (key TEXT NOT NULL, channel TEXT NOT NULL, tbl TEXT NOT NULL,
        rid INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rows_key ON rows (key, channel);
    `);
  }

  private ensure(name: string) {
    if (this.tables.has(name)) return;
    // Accents fold, so "creme" finds "crème"; prefixes of 2 and 3 make the last term's prefix fast.
    this.sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(title, brand, skus, body,
        uid UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
    );
    this.tables.add(name);
  }

  private exists(name: string): boolean {
    if (this.tables.has(name)) return true;
    const found = this.sql
      .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name)
      .toArray().length;
    if (found) this.tables.add(name);
    return found > 0;
  }

  apply(items: Item[]) {
    this.sql.exec(
      'DELETE FROM seen WHERE at < ? AND key NOT IN (SELECT key FROM rows)',
      Date.now() - TOMBSTONE_MS,
    );
    this.ctx.storage.transactionSync(() => {
      for (const item of items) {
        const seen = this.sql
          .exec<{ at: number }>(
            'SELECT at FROM seen WHERE key = ? AND channel = ?',
            item.key,
            item.channel,
          )
          .toArray()[0];
        if (seen && seen.at >= item.at) continue;
        this.sql.exec(
          'INSERT OR REPLACE INTO seen VALUES (?, ?, ?)',
          item.key,
          item.channel,
          item.at,
        );
        for (const r of this.sql
          .exec<{ tbl: string; rid: number }>(
            'SELECT tbl, rid FROM rows WHERE key = ? AND channel = ?',
            item.key,
            item.channel,
          )
          .toArray())
          this.sql.exec(`DELETE FROM ${r.tbl} WHERE rowid = ?`, r.rid);
        this.sql.exec('DELETE FROM rows WHERE key = ? AND channel = ?', item.key, item.channel);
        for (const d of item.docs ?? []) {
          const name = table(item.channel, d.locale);
          this.ensure(name);
          this.sql.exec(
            `INSERT INTO ${name} (title, brand, skus, body, uid) VALUES (?, ?, ?, ?, ?)`,
            d.title,
            d.brand,
            d.skus,
            d.body,
            item.uid,
          );
          const rid = this.sql.exec<{ rid: number }>('SELECT last_insert_rowid() AS rid').one().rid;
          this.sql.exec('INSERT INTO rows VALUES (?, ?, ?, ?)', item.key, item.channel, name, rid);
        }
      }
    });
  }

  /** This shard's best `k` matches (lower score is better, as bm25 ranks) and how many match. */
  search(channel: string, locale: string, match: string, k: number): SearchHits {
    const name = table(channel, locale);
    if (!this.exists(name)) return { total: 0, hits: [] };
    const hits = this.sql
      .exec<{ uid: number; score: number }>(
        `SELECT uid, bm25(${name}, ${WEIGHTS}) AS score FROM ${name} WHERE ${name} MATCH ?
         ORDER BY score LIMIT ?`,
        match,
        k,
      )
      .toArray();
    const total =
      hits.length < k
        ? hits.length
        : this.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name} WHERE ${name} MATCH ?`, match)
            .one().n;
    return { total, hits };
  }
}

/** catalog-edge's search: every shard at once, merged by score. */
export class SearchApi extends WorkerEntrypoint<Env> {
  async search(
    channel: string,
    locale: string,
    q: string,
    limit: number,
    offset: number,
  ): Promise<{ total: number; uids: number[]; partial?: true }> {
    const match = ftsQuery(normalizeQuery(q));
    const k = Math.min(offset + limit, SEARCH_DEPTH);
    if (!match || offset >= k) return { total: 0, uids: [] };
    // A shard that fails leaves its matches out rather than failing the search: say so.
    const settled = await Promise.allSettled(
      Array.from({ length: SEARCH_SHARDS }, (_, n) =>
        searcher(this.env, n).search(channel, locale, match, k),
      ),
    );
    const results: SearchHits[] = [];
    for (const [n, s] of settled.entries())
      if (s.status === 'fulfilled') results.push(s.value);
      else console.error(`search shard ${n} failed`, s.reason);
    const partial = results.length < SEARCH_SHARDS;
    const merged = results
      .flatMap((r) => r.hits)
      .sort((a, b) => a.score - b.score || a.uid - b.uid)
      .slice(offset, k);
    return {
      total: results.reduce((sum, r) => sum + r.total, 0),
      uids: merged.map((h) => h.uid),
      ...(partial ? { partial: true as const } : {}),
    };
  }
}
