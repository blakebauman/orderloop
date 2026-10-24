/**
 * CatalogShard: one of 64 SQLite Durable Objects that together are the catalog's source of truth.
 * A shard owns the products whose key hashes to it (core's productShard) and the alias claims (SKU,
 * GTIN, slug) that hash to it (aliasShard), so uniqueness never needs a global object.
 *
 * A write lands in one transaction with an outbox row; the shard's alarm then publishes from the
 * outbox (publish.ts), so a product is never stored without being published, and a crash between
 * the two only means it publishes on the alarm's retry. Unchanged products (same content hash)
 * write nothing, which is what keeps a daily full feed cheap.
 *
 * Alias claims on other shards are awaited outside any transaction and never while holding the
 * shard's input gate, so two shards claiming from each other can't deadlock; the transaction then
 * re-checks what it read.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  aliasShard,
  contentHash,
  type Issue,
  type Product,
  type ProductData,
  productAliases,
  productShard,
  productUid,
  type WriteResult,
} from '@orderloop/core/product';
import { type CatalogConfig, meta, shard } from './config';
import { publishKeys } from './publish';

export type ApplyBatch = {
  /** This shard's number (the caller routed by it). */
  shard: number;
  /** Re-applying a batch id returns the first result and writes nothing. */
  batchId: string;
  rows: ProductData[];
  /** The config revision the rows were validated against. */
  rev: number;
  by: string;
  urgent?: boolean;
};

type Row = {
  key: string;
  uid: number;
  version: number;
  hash: string;
  body: string;
  created_at: number;
};

/** Alarm passes: products published per pass. */
const PUBLISH_BATCH = 100;
/** How long a batch id is remembered: longer than a feed part can wait to be redelivered. */
const APPLIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CatalogShard extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private config: CatalogConfig | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS products (
        key TEXT PRIMARY KEY, uid INTEGER NOT NULL UNIQUE, type TEXT NOT NULL,
        type_version INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        hash TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, urgent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS applied (batch TEXT PRIMARY KEY, at INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS published (
        key TEXT NOT NULL, channel TEXT NOT NULL, locales TEXT NOT NULL, aliases TEXT NOT NULL,
        PRIMARY KEY (key, channel));
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
  }

  private setting(k: string): number | undefined {
    return this.sql.exec<{ v: number }>('SELECT v FROM settings WHERE k = ?', k).toArray()[0]?.v;
  }

  private shardNumber(n: number) {
    const known = this.setting('shard');
    if (known === undefined) this.sql.exec(`INSERT INTO settings VALUES ('shard', ?)`, n);
    else if (known !== n) throw new Error(`shard ${known} was called as shard ${n}`);
  }

  /** The config at revision `rev` or later, fetched from CatalogMeta when this copy is older. */
  async loadConfig(rev?: number): Promise<CatalogConfig> {
    if (!this.config || rev === undefined || this.config.rev < rev)
      this.config = await meta(this.env).getConfig();
    return this.config;
  }

  private read(key: string): Row | undefined {
    return this.sql
      .exec<Row>(
        'SELECT key, uid, version, hash, body, created_at FROM products WHERE key = ?',
        key,
      )
      .toArray()[0];
  }

  async apply(batch: ApplyBatch): Promise<WriteResult[]> {
    this.shardNumber(batch.shard);
    const done = this.sql
      .exec<{ result: string }>('SELECT result FROM applied WHERE batch = ?', batch.batchId)
      .toArray()[0];
    if (done) return JSON.parse(done.result) as WriteResult[];

    // 1. What changes: rows whose content hash differs from what's stored. A key repeated in the
    // batch keeps its last row.
    const last = new Map(batch.rows.map((data, i) => [data.key, i]));
    const planned = batch.rows.map((data, i) => {
      const hash = contentHash(data);
      const before = this.read(data.key);
      const prevAliases = before ? productAliases(JSON.parse(before.body) as ProductData) : [];
      const repeated = last.get(data.key) !== i;
      return { data, hash, before, prevAliases, aliases: productAliases(data), repeated };
    });
    const changed = planned.filter((p) => !p.repeated && p.hash !== p.before?.hash);

    // 2. Claim new aliases on the shards that own them, outside any transaction.
    const claims = new Map<number, { owner: string; aliases: string[] }[]>();
    for (const p of changed) {
      const prev = new Set(p.prevAliases);
      const add = p.aliases.filter((a) => !prev.has(a));
      for (const a of add) {
        const n = aliasShard(a);
        const list = claims.get(n) ?? [];
        list.push({ owner: p.data.key, aliases: [a] });
        claims.set(n, list);
      }
    }
    const conflicts = new Map<string, Issue[]>();
    await Promise.all(
      [...claims].map(async ([n, items]) => {
        const lost = await this.claimOn(batch.shard, n, items);
        for (const c of lost) {
          const list = conflicts.get(c.owner) ?? [];
          list.push({ path: c.alias, message: `already used by ${c.holder}` });
          conflicts.set(c.owner, list);
        }
      }),
    );

    // 3. One transaction: re-read (another request may have written meanwhile), then write.
    const now = Date.now();
    const results: WriteResult[] = [];
    const releases: { owner: string; alias: string }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const p of planned) {
        if (p.repeated) {
          results.push({
            key: p.data.key,
            status: 'rejected',
            issues: [{ path: 'key', message: 'repeated later in the same batch' }],
          });
          continue;
        }
        const current = this.read(p.data.key);
        if (current?.hash === p.hash) {
          results.push({ key: p.data.key, status: 'unchanged', version: current.version });
          continue;
        }
        // Another write landed while this one claimed aliases: what was claimed may be wrong.
        const raced = current?.hash !== p.before?.hash;
        const issues = raced
          ? [{ path: 'key', message: 'changed by another write meanwhile; send it again' }]
          : conflicts.get(p.data.key);
        if (issues) {
          results.push({ key: p.data.key, status: 'rejected', issues });
          // Give back what this product did claim.
          const prev = new Set(p.prevAliases);
          for (const a of p.aliases)
            if (!prev.has(a)) releases.push({ owner: p.data.key, alias: a });
          continue;
        }
        const version = (current?.version ?? 0) + 1;
        if (current)
          this.sql.exec(
            `UPDATE products SET type = ?, type_version = ?, status = ?, version = ?, hash = ?,
             body = ?, updated_at = ?, updated_by = ? WHERE key = ?`,
            p.data.type,
            p.data.typeVersion,
            p.data.status,
            version,
            p.hash,
            JSON.stringify(p.data),
            now,
            batch.by,
            p.data.key,
          );
        else {
          const seq = this.setting('seq') ?? 0;
          this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('seq', ?)`, seq + 1);
          this.sql.exec(
            'INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            p.data.key,
            productUid(batch.shard, seq),
            p.data.type,
            p.data.typeVersion,
            p.data.status,
            version,
            p.hash,
            JSON.stringify(p.data),
            now,
            now,
            batch.by,
          );
        }
        this.sql.exec(
          'INSERT INTO outbox (key, urgent) VALUES (?, ?)',
          p.data.key,
          batch.urgent ? 1 : 0,
        );
        const next = new Set(p.aliases);
        for (const a of p.prevAliases)
          if (!next.has(a)) releases.push({ owner: p.data.key, alias: a });
        results.push({ key: p.data.key, status: current ? 'updated' : 'created', version });
      }
      this.sql.exec(
        'INSERT INTO applied VALUES (?, ?, ?)',
        batch.batchId,
        now,
        JSON.stringify(results),
      );
    });
    await this.releaseOn(batch.shard, releases);
    await this.schedulePublish();
    return results;
  }

  async remove(input: {
    shard: number;
    keys: string[];
    by: string;
    urgent?: boolean;
  }): Promise<WriteResult[]> {
    this.shardNumber(input.shard);
    const results: WriteResult[] = [];
    const releases: { owner: string; alias: string }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const key of input.keys) {
        const row = this.read(key);
        if (!row) {
          results.push({ key, status: 'unchanged' });
          continue;
        }
        this.sql.exec('DELETE FROM products WHERE key = ?', key);
        this.sql.exec('INSERT INTO outbox (key, urgent) VALUES (?, ?)', key, input.urgent ? 1 : 0);
        for (const alias of productAliases(JSON.parse(row.body) as ProductData))
          releases.push({ owner: key, alias });
        results.push({ key, status: 'deleted', version: row.version });
      }
    });
    await this.releaseOn(input.shard, releases);
    await this.schedulePublish();
    return results;
  }

  /** Queues every product for the publisher (a reindex), once each. Returns how many. */
  async republishAll(n: number): Promise<number> {
    this.shardNumber(n);
    const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM products').one().n;
    if (!count) return 0;
    // A product already waiting publishes its latest state anyway: don't queue it twice.
    this.sql.exec(
      'INSERT INTO outbox (key, urgent) SELECT key, 0 FROM products WHERE key NOT IN (SELECT key FROM outbox)',
    );
    await this.schedulePublish();
    return count;
  }

  get(key: string): Product | null {
    const row = this.sql
      .exec<Row & { updated_at: number }>('SELECT * FROM products WHERE key = ?', key)
      .toArray()[0];
    if (!row) return null;
    return {
      ...(JSON.parse(row.body) as ProductData),
      version: row.version,
      hash: row.hash,
      updatedAt: row.updated_at,
    };
  }

  /** Whether `key` (on this shard) still claims `alias`: how a stale claim elsewhere is spotted. */
  holds(key: string, alias: string): boolean {
    const row = this.read(key);
    return !!row && productAliases(JSON.parse(row.body) as ProductData).includes(alias);
  }

  // --- Alias claims (this shard as the alias owner) ---

  /**
   * Claims each alias for its owner. Returns the ones another product holds. Synchronous, so a
   * claim is atomic and never waits on another shard.
   */
  claim(
    items: { owner: string; aliases: string[] }[],
  ): { owner: string; alias: string; holder: string }[] {
    const lost: { owner: string; alias: string; holder: string }[] = [];
    for (const { owner, aliases } of items)
      for (const alias of aliases) {
        const holder = this.owner(alias);
        if (holder === null) this.sql.exec('INSERT INTO aliases VALUES (?, ?)', alias, owner);
        else if (holder !== owner) lost.push({ owner, alias, holder });
      }
    return lost;
  }

  /** Moves `alias` to `owner` if `previous` still holds it (the stale claim was checked). */
  takeOver(alias: string, owner: string, previous: string): boolean {
    const current = this.owner(alias);
    if (current !== previous) return current === owner;
    this.sql.exec('UPDATE aliases SET owner = ? WHERE alias = ?', owner, alias);
    return true;
  }

  release(items: { owner: string; alias: string }[]) {
    for (const { owner, alias } of items)
      this.sql.exec('DELETE FROM aliases WHERE alias = ? AND owner = ?', alias, owner);
  }

  owner(alias: string): string | null {
    return (
      this.sql
        .exec<{ owner: string }>('SELECT owner FROM aliases WHERE alias = ?', alias)
        .toArray()[0]?.owner ?? null
    );
  }

  /** Claims on shard `n` (this one, directly), taking over claims whose holder let go. */
  private async claimOn(
    self: number,
    n: number,
    items: { owner: string; aliases: string[] }[],
  ): Promise<{ owner: string; alias: string; holder: string }[]> {
    const local = n === self;
    const remote = shard(this.env, n);
    const lost = local ? this.claim(items) : await remote.claim(items);
    const still: { owner: string; alias: string; holder: string }[] = [];
    for (const c of lost) {
      // A claim outlives its product when a release failed: ask the holder's shard.
      const h = productShard(c.holder);
      const holds =
        h === self
          ? this.holds(c.holder, c.alias)
          : await shard(this.env, h).holds(c.holder, c.alias);
      const taken =
        !holds &&
        (local
          ? this.takeOver(c.alias, c.owner, c.holder)
          : await remote.takeOver(c.alias, c.owner, c.holder));
      if (!taken) still.push(c);
    }
    return still;
  }

  private async releaseOn(self: number, items: { owner: string; alias: string }[]) {
    const byShard = new Map<number, { owner: string; alias: string }[]>();
    for (const item of items) {
      const n = aliasShard(item.alias);
      const list = byShard.get(n) ?? [];
      list.push(item);
      byShard.set(n, list);
    }
    // Best effort: a release that fails leaves a stale claim, which claimOn takes over later.
    await Promise.allSettled(
      [...byShard].map(async ([n, list]) =>
        n === self ? this.release(list) : await shard(this.env, n).release(list),
      ),
    );
  }

  // --- Publishing ---

  private async schedulePublish() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Products waiting to publish (tests and the status page read it). */
  pending(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(DISTINCT key) AS n FROM outbox').one().n;
  }

  override async alarm() {
    this.sql.exec('DELETE FROM applied WHERE at < ?', Date.now() - APPLIED_TTL_MS);
    const config = await this.loadConfig();
    const rows = this.sql
      .exec<{ seq: number; key: string; urgent: number }>(
        'SELECT seq, key, urgent FROM outbox ORDER BY seq LIMIT ?',
        PUBLISH_BATCH * 4,
      )
      .toArray();
    if (!rows.length) return;
    const keys = [...new Set(rows.map((r) => r.key))].slice(0, PUBLISH_BATCH);
    const included = new Set(keys);
    const upTo = rows.filter((r) => included.has(r.key)).at(-1)?.seq ?? 0;
    await publishKeys(this, keys, config);
    // Every outbox row up to the last one published is covered: later rows for the same key
    // republish the same (latest) state.
    this.sql.exec(
      'DELETE FROM outbox WHERE seq <= ? AND key IN (SELECT value FROM json_each(?))',
      upTo,
      JSON.stringify(keys),
    );
    if (this.pending()) await this.ctx.storage.setAlarm(Date.now());
  }

  // --- Used by the publisher ---

  /** The stored row for publishing, or null when the product is gone. */
  publishable(key: string): { product: Product; uid: number; createdAt: number } | null {
    const row = this.sql
      .exec<Row & { updated_at: number }>('SELECT * FROM products WHERE key = ?', key)
      .toArray()[0];
    if (!row) return null;
    return {
      product: {
        ...(JSON.parse(row.body) as ProductData),
        version: row.version,
        hash: row.hash,
        updatedAt: row.updated_at,
      },
      uid: row.uid,
      createdAt: row.created_at,
    };
  }

  publishedState(
    key: string,
  ): { channel: string; locales: string[]; aliases: string[]; uid: number }[] {
    return this.sql
      .exec<{ channel: string; locales: string; aliases: string }>(
        'SELECT channel, locales, aliases FROM published WHERE key = ?',
        key,
      )
      .toArray()
      .map((r) => {
        const parsed = JSON.parse(r.aliases) as { uid: number; aliases: string[] };
        return {
          channel: r.channel,
          locales: JSON.parse(r.locales) as string[],
          aliases: parsed.aliases,
          uid: parsed.uid,
        };
      });
  }

  recordPublished(
    key: string,
    channel: string,
    state: { locales: string[]; aliases: string[]; uid: number } | null,
  ) {
    if (!state) this.sql.exec('DELETE FROM published WHERE key = ? AND channel = ?', key, channel);
    else
      this.sql.exec(
        'INSERT OR REPLACE INTO published VALUES (?, ?, ?, ?)',
        key,
        channel,
        JSON.stringify(state.locales),
        JSON.stringify({ uid: state.uid, aliases: state.aliases }),
      );
  }

  get publishEnv(): Env {
    return this.env;
  }
}
