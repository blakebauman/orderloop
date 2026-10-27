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
 *
 * The same transaction keeps the product editor's state (docs/product-editor.md). A product's
 * stored body is what goes live: the feed's version with the editor's overrides applied, so the
 * next import doesn't wipe an edit; while it has overrides, the feed's own version is kept beside it
 * (`feed_rows`). Edits are staged first and go live only when published. Each product's content
 * gaps and conflicts, the last row refused for its key, and its card on the board are rewritten with
 * it. CatalogApi sums and pages them across shards, so no shard ever asks another.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  aliasShard,
  applyOverrides,
  type BasedOverride,
  type BoardCard,
  type BoardColumn,
  contentGaps,
  contentHash,
  DOC_FORMAT,
  type Draft,
  type DraftInput,
  type EditResult,
  type EditSource,
  editIssues,
  type FieldOverride,
  type FieldRef,
  fieldId,
  fieldValue,
  type Gap,
  type GapKind,
  type Issue,
  type Localized,
  overrideConflict,
  type Product,
  type ProductData,
  type ProductSheet,
  type PublishResult,
  type PurgeMessage,
  parseFieldId,
  paths,
  productAliases,
  productShard,
  productUid,
  type Rejection,
  type Revision,
  type StagedEdit,
  type StageEdit,
  tags,
  type WriteResult,
} from '@orderloop/core/product';
import { type CatalogConfig, meta, shard, typeResolver } from './config';
import { type ListingChange, sendChanges } from './listings';
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
  /** The feed the batch is part of, recorded with its rejections. */
  feed?: string;
  /** Rows the feed refused before they reached a shard, for keys this shard owns. */
  rejected?: RejectedRow[];
  /** Each row's number in its feed, recorded with a refusal. */
  rowNumbers?: number[];
};

/**
 * A row refused for a product key: why, and enough to show it on the board. `at` is when it was
 * refused: parts can apply out of order, and a refusal older than the product's last write no
 * longer stands.
 */
export type RejectedRow = {
  key: string;
  title: string;
  row?: number;
  issues: Issue[];
  at?: number;
};

/** Gap kinds rewritten with a product: its content's (`contentGaps`) and its overrides' conflicts. */
const CONTENT_KINDS: GapKind[] = [
  'missing_title',
  'missing_description',
  'missing_attribute',
  'missing_alt',
  'conflict',
];
const IN_CONTENT = `kind IN (${CONTENT_KINDS.map((k) => `'${k}'`).join(', ')})`;

/** A title to show for a product: any locale's. */
const anyText = (l: Localized | undefined) => (l ? (Object.values(l)[0] ?? '') : '');

/** The field and locale an edit names, as stored (`locale` is '' for status), or null for none. */
function fieldKey(ref: FieldRef): { field: string; locale: string; ref: FieldRef } | null {
  const parsed = parseFieldId(fieldId(ref));
  if (!parsed) return null;
  const locale = parsed.field === 'status' ? '' : (ref.locale ?? '');
  return { field: fieldId(parsed), locale, ref: locale ? { ...parsed, locale } : parsed };
}

/** The edit a stored field and locale name. */
function refOf(field: string, locale: string): FieldRef {
  const parsed = parseFieldId(field) ?? { field: 'title' };
  return locale ? { ...parsed, locale } : parsed;
}

/** A field and locale for a person to read: `description (fr)`. */
const label = (field: string, locale: string) => (locale ? `${field} (${locale})` : field);

type OverrideRow = {
  field: string;
  locale: string;
  value: string | null;
  base: string | null;
  source: EditSource;
  who: string;
  at: number;
};
type StagedRow = {
  field: string;
  locale: string;
  op: 'set' | 'clear';
  value: string | null;
  seen: string | null;
  source: EditSource;
  who: string;
  at: number;
  failure: string | null;
};
/** A change publishing will record, before it has a time. */
type PlannedRevision = Omit<Revision, 'ref' | 'at'> & { field: string; locale: string };
const asOverride = (o: OverrideRow): BasedOverride => ({
  ref: refOf(o.field, o.locale),
  value: o.value,
  base: o.base,
});

/** How long a product stays in the board's Published column. */
const PUBLISHED_FOR_MS = 24 * 60 * 60 * 1000;
/** Published changes kept per product for the sheet's history. */
const REVISIONS_KEPT = 50;

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
/** Passes an alarm keeps in flight at once, on disjoint products. */
const PUBLISH_PASSES = 4;
/** How long one alarm keeps starting passes before it hands over to the next alarm. */
const ALARM_WINDOW_MS = 60_000;

type OutboxRow = { seq: number; key: string; urgent: number; rev: number | null; forced: number };
/** Cache tags per purge message: what one purge call takes. */
const PURGE_TAGS = 100;
/** How long a shard trusts its copy of the config without a newer revision asking for more. */
const CONFIG_TTL_MS = 2_000;
/** Products an alarm's gap rebuild reads per page. */
const GAP_PAGE = 500;
/** How long a batch id is remembered: longer than a feed part can wait to be redelivered. */
const APPLIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CatalogShard extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private config: CatalogConfig | undefined;
  private configAt = 0;

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
      CREATE INDEX IF NOT EXISTS outbox_key ON outbox (key);
      CREATE INDEX IF NOT EXISTS applied_at ON applied (at);
      CREATE TABLE IF NOT EXISTS gaps (
        key TEXT NOT NULL, kind TEXT NOT NULL, field TEXT NOT NULL, locale TEXT NOT NULL,
        channel TEXT NOT NULL, PRIMARY KEY (key, kind, field, locale, channel));
      CREATE INDEX IF NOT EXISTS gaps_kind ON gaps (kind, key);
      CREATE TABLE IF NOT EXISTS rejections (
        key TEXT PRIMARY KEY, title TEXT NOT NULL, feed TEXT, row INTEGER, issues TEXT NOT NULL,
        at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS board (
        key TEXT PRIMARY KEY, col TEXT NOT NULL, title TEXT NOT NULL, kinds TEXT NOT NULL,
        at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS board_col ON board (col, key);
      CREATE TABLE IF NOT EXISTS gap_rebuild (
        id INTEGER PRIMARY KEY CHECK (id = 1), requested INTEGER NOT NULL, due INTEGER NOT NULL,
        cursor TEXT);
      CREATE TABLE IF NOT EXISTS feed_rows (
        key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL, live TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overrides (
        key TEXT NOT NULL, field TEXT NOT NULL, locale TEXT NOT NULL, value TEXT, base TEXT,
        source TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (key, field, locale));
      CREATE TABLE IF NOT EXISTS staged (
        key TEXT NOT NULL, field TEXT NOT NULL, locale TEXT NOT NULL, op TEXT NOT NULL, value TEXT,
        seen TEXT, source TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, failure TEXT,
        PRIMARY KEY (key, field, locale));
      CREATE TABLE IF NOT EXISTS revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, field TEXT NOT NULL,
        locale TEXT NOT NULL, op TEXT NOT NULL, value TEXT, previous TEXT, source TEXT NOT NULL,
        who TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_key ON revisions (key, seq);
      CREATE TABLE IF NOT EXISTS drafts (
        key TEXT NOT NULL, field TEXT NOT NULL, locale TEXT NOT NULL, value TEXT NOT NULL,
        seen TEXT, model TEXT, who TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (key, field, locale));
    `);
    // Added later, so shards created before them gain them here. `rev`: the config revision a write
    // was validated against (null: unknown, so the alarm fetches the latest). `forced`: a reindex,
    // which rewrites what an ordinary publish skips as unchanged.
    const columns = new Set(
      this.sql
        .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'outbox')
        .toArray()
        .map((c) => c.name),
    );
    if (!columns.has('rev')) this.sql.exec('ALTER TABLE outbox ADD COLUMN rev INTEGER');
    if (!columns.has('forced'))
      this.sql.exec('ALTER TABLE outbox ADD COLUMN forced INTEGER NOT NULL DEFAULT 0');
    // Every write keeps the gap index from here on: a shard with no products yet is complete.
    // One that held products before the index existed is complete once `refreshGaps` has run,
    // which it queues for itself (`backfillGaps`).
    if (
      this.setting('gaps_built') === undefined &&
      !this.sql.exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM products) AS e').one().e
    )
      this.sql.exec(`INSERT INTO settings VALUES ('gaps_built', 1)`);
    void ctx.blockConcurrencyWhile(() => this.backfillGaps());
  }

  /**
   * A shard that held products before the gap index existed (it has no `gaps_built`) queues the
   * rebuild a channel change does, once, the first time it wakes on a Worker with the index, so no
   * deployment needs `rebuildGaps` run by hand. Until it finishes the board says the index isn't
   * built. A shard that has never been told its number waits for `rebuildGaps`, which tells it.
   */
  private async backfillGaps() {
    if (this.setting('gaps_built') !== undefined || this.setting('shard') === undefined) return;
    const now = Date.now();
    const due = now + (Number(this.env.GAP_REBUILD_DELAY_MS) || 0);
    this.sql.exec('INSERT OR REPLACE INTO gap_rebuild VALUES (1, ?, ?, NULL)', now, due);
    this.sql.exec(`INSERT INTO settings VALUES ('gaps_built', 0)`);
    await this.scheduleAt(due);
  }

  private setting(k: string): number | undefined {
    return this.sql.exec<{ v: number }>('SELECT v FROM settings WHERE k = ?', k).toArray()[0]?.v;
  }

  private shardNumber(n: number) {
    const known = this.setting('shard');
    if (known === undefined) this.sql.exec(`INSERT INTO settings VALUES ('shard', ?)`, n);
    else if (known !== n) throw new Error(`shard ${known} was called as shard ${n}`);
  }

  /**
   * The config at revision `rev` or later, fetched from CatalogMeta when this copy is older than
   * that or than CONFIG_TTL_MS. Without a revision, always fetched.
   */
  async loadConfig(rev?: number): Promise<CatalogConfig> {
    if (
      !this.config ||
      rev === undefined ||
      this.config.rev < rev ||
      Date.now() - this.configAt > CONFIG_TTL_MS
    ) {
      this.config = await meta(this.env).getConfig();
      this.configAt = Date.now();
    }
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

  /** When a stored product was last written. */
  private updatedAt(key: string): number | undefined {
    return this.sql
      .exec<{ at: number }>('SELECT updated_at AS at FROM products WHERE key = ?', key)
      .toArray()[0]?.at;
  }

  /** A stored product's version and content hash, without its body. */
  private head(key: string): { version: number; hash: string } | undefined {
    return this.sql
      .exec<{ version: number; hash: string }>(
        'SELECT version, hash FROM products WHERE key = ?',
        key,
      )
      .toArray()[0];
  }

  /** The aliases a stored product claims (its body parsed). */
  private storedAliases(key: string): string[] {
    const row = this.sql
      .exec<{ body: string }>('SELECT body FROM products WHERE key = ?', key)
      .toArray()[0];
    return row ? productAliases(JSON.parse(row.body) as ProductData) : [];
  }

  /** The feed's version of a stored product: kept apart only while it has overrides. */
  private feedOf(key: string): ProductData | undefined {
    const row =
      this.sql
        .exec<{ body: string }>('SELECT body FROM feed_rows WHERE key = ?', key)
        .toArray()[0] ??
      this.sql.exec<{ body: string }>('SELECT body FROM products WHERE key = ?', key).toArray()[0];
    return row ? (JSON.parse(row.body) as ProductData) : undefined;
  }

  /**
   * The content hash of the feed's version: what an unchanged feed row is recognized by. A kept
   * feed row counts only while the live product is still the one its overrides made (`live`): one
   * written without them (by a Worker from before overrides, during a rollback) is recomputed.
   */
  private feedHash(key: string): string | undefined {
    const kept = this.sql
      .exec<{ hash: string; fresh: number }>(
        `SELECT f.hash, p.hash = f.live AS fresh FROM feed_rows f JOIN products p ON p.key = f.key
         WHERE f.key = ?`,
        key,
      )
      .toArray()[0];
    if (kept) return kept.fresh ? kept.hash : undefined;
    return this.head(key)?.hash;
  }

  private overrideRows(key: string): OverrideRow[] {
    return this.sql
      .exec<OverrideRow>(
        'SELECT field, locale, value, base, source, who, at FROM overrides WHERE key = ? ORDER BY field, locale',
        key,
      )
      .toArray();
  }

  private stagedRows(key: string): StagedRow[] {
    return this.sql
      .exec<StagedRow>(
        `SELECT field, locale, op, value, seen, source, who, at, failure FROM staged WHERE key = ?
         ORDER BY field, locale`,
        key,
      )
      .toArray();
  }

  /**
   * Keeps the feed's version beside the live one (whose hash is `live`) while the product has
   * overrides; else drops it.
   */
  private storeFeed(key: string, feed: ProductData, hash: string, live: string) {
    const overridden = this.sql
      .exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM overrides WHERE key = ?) AS e', key)
      .one().e;
    if (overridden)
      this.sql.exec(
        'INSERT OR REPLACE INTO feed_rows VALUES (?, ?, ?, ?)',
        key,
        hash,
        JSON.stringify(feed),
        live,
      );
    else this.sql.exec('DELETE FROM feed_rows WHERE key = ?', key);
  }

  /** Drops a product's editor state: its feed row, overrides, staged edits, drafts and history. */
  private forgetEdits(key: string) {
    for (const t of ['feed_rows', 'overrides', 'staged', 'drafts', 'revisions'])
      this.sql.exec(`DELETE FROM ${t} WHERE key = ?`, key);
  }

  /** Stores the live product as a new version and queues it to publish. Returns the version. */
  private writeProduct(
    data: ProductData,
    hash: string,
    current: { version: number } | undefined,
    w: { shard: number; by: string; urgent?: boolean; rev: number | null },
    now: number,
  ): number {
    const version = (current?.version ?? 0) + 1;
    if (current)
      this.sql.exec(
        `UPDATE products SET type = ?, type_version = ?, status = ?, version = ?, hash = ?,
         body = ?, updated_at = ?, updated_by = ? WHERE key = ?`,
        data.type,
        data.typeVersion,
        data.status,
        version,
        hash,
        JSON.stringify(data),
        now,
        w.by,
        data.key,
      );
    else {
      const seq = this.setting('seq') ?? 0;
      this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('seq', ?)`, seq + 1);
      this.sql.exec(
        'INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        data.key,
        productUid(w.shard, seq),
        data.type,
        data.typeVersion,
        data.status,
        version,
        hash,
        JSON.stringify(data),
        now,
        now,
        w.by,
      );
    }
    this.sql.exec(
      'INSERT INTO outbox (key, urgent, rev) VALUES (?, ?, ?)',
      data.key,
      w.urgent ? 1 : 0,
      w.rev,
    );
    return version;
  }

  /**
   * Claims the aliases each product gains on the shards that own them, outside any transaction.
   * Returns, per product, the ones another product holds.
   */
  private async claimAliases(
    self: number,
    items: { key: string; prev: string[]; next: string[] }[],
  ): Promise<Map<string, Issue[]>> {
    const claims = new Map<number, { owner: string; aliases: string[] }[]>();
    for (const p of items) {
      const prev = new Set(p.prev);
      for (const a of p.next.filter((x) => !prev.has(x))) {
        const n = aliasShard(a);
        const list = claims.get(n) ?? [];
        list.push({ owner: p.key, aliases: [a] });
        claims.set(n, list);
      }
    }
    const conflicts = new Map<string, Issue[]>();
    await Promise.all(
      [...claims].map(async ([n, list]) => {
        const lost = await this.claimOn(self, n, list);
        for (const c of lost) {
          const issues = conflicts.get(c.owner) ?? [];
          issues.push({ path: c.alias, message: `already used by ${c.holder}` });
          conflicts.set(c.owner, issues);
        }
      }),
    );
    return conflicts;
  }

  /** Aliases to give back: what a product no longer claims, or what it claimed for a refused write. */
  private static releases(key: string, give: string[], keep: string[]) {
    const kept = new Set(keep);
    return give.filter((a) => !kept.has(a)).map((alias) => ({ owner: key, alias }));
  }

  async apply(batch: ApplyBatch): Promise<WriteResult[]> {
    this.shardNumber(batch.shard);
    const done = this.sql
      .exec<{ result: string }>('SELECT result FROM applied WHERE batch = ?', batch.batchId)
      .toArray()[0];
    if (done) return JSON.parse(done.result) as WriteResult[];

    // 1. What changes: rows whose content hash differs from the feed version stored. A key repeated
    // in the batch keeps its last row. Only a changed row's stored body is parsed (for its old
    // aliases) and its overrides applied: in a daily full feed, most rows are unchanged.
    const last = new Map(batch.rows.map((data, i) => [data.key, i]));
    const planned = batch.rows.map((data, i) => {
      const feedHash = contentHash(data);
      const before = this.head(data.key);
      const repeated = last.get(data.key) !== i;
      const changes = !repeated && feedHash !== this.feedHash(data.key);
      // What goes live: the row with the product's overrides over it. A new product has none
      // (rows a Worker from before overrides left for a deleted key are cleared when it's written).
      const live =
        changes && before
          ? applyOverrides(data, this.overrideRows(data.key).map(asOverride))
          : data;
      const prevAliases = changes && before ? this.storedAliases(data.key) : [];
      const hash = live === data ? feedHash : contentHash(live);
      return {
        i,
        data,
        feedHash,
        live,
        hash,
        before,
        prevAliases,
        aliases: productAliases(live),
        repeated,
        changes,
      };
    });
    const changed = planned.filter((p) => p.changes);
    // Types and channels for the changed products' gaps: from CatalogMeta, never another shard,
    // and only when something changes (a daily full feed is mostly unchanged rows).
    const config = changed.length ? await this.loadConfig(batch.rev) : undefined;

    // 2. Claim new aliases on the shards that own them, outside any transaction.
    const conflicts = await this.claimAliases(
      batch.shard,
      changed.map((p) => ({ key: p.data.key, prev: p.prevAliases, next: p.aliases })),
    );

    // 3. One transaction: re-read (another request may have written meanwhile), then write.
    const now = Date.now();
    const results: WriteResult[] = [];
    const releases: { owner: string; alias: string }[] = [];
    this.ctx.storage.transactionSync(() => {
      // Refused rows first: a good row for the same key later in the feed clears them.
      for (const r of batch.rejected ?? []) {
        if (r.at !== undefined && r.at < (this.updatedAt(r.key) ?? 0)) continue;
        this.writeRejection(r.key, { ...r, feed: batch.feed }, now);
        this.refreshBoard(r.key, now);
      }
      for (const p of planned) {
        const key = p.data.key;
        if (p.repeated) {
          results.push({
            key,
            status: 'rejected',
            issues: [{ path: 'key', message: 'repeated later in the same batch' }],
          });
          continue;
        }
        const current = this.head(key);
        if (current && p.feedHash === this.feedHash(key)) {
          results.push({ key, status: 'unchanged', version: current.version });
          // Sent again as it is: whatever was refused for it before no longer stands.
          if (this.writeRejection(key, null, now)) this.refreshBoard(key, now);
          continue;
        }
        // Another write (or a publish) landed while this one claimed aliases: what was claimed,
        // and the overrides applied, may be wrong. By version, since a write can change overrides
        // or the feed's row and leave the live content (its hash) as it was.
        const raced = !p.changes || current?.version !== p.before?.version;
        const issues = raced
          ? [{ path: 'key', message: 'changed by another write meanwhile; send it again' }]
          : conflicts.get(key);
        if (issues) {
          results.push({ key, status: 'rejected', issues });
          // A taken alias is the sender's to fix: it goes on the board. A race just needs a resend.
          if (!raced) {
            this.writeRejection(
              key,
              {
                key,
                title: anyText(p.data.title),
                issues,
                feed: batch.feed,
                row: batch.rowNumbers?.[p.i],
              },
              now,
            );
            this.refreshBoard(key, now);
          }
          // Give back what this one claimed, but not what the product as stored now holds: a
          // write that raced it may have claimed the same alias for it.
          releases.push(...CatalogShard.releases(key, p.aliases, this.storedAliases(key)));
          continue;
        }
        if (!current) this.forgetEdits(key);
        const version = this.writeProduct(p.live, p.hash, current, batch, now);
        releases.push(...CatalogShard.releases(key, p.prevAliases, p.aliases));
        this.storeFeed(key, p.data, p.feedHash, p.hash);
        if (config) this.writeGaps(key, p.live, config);
        this.writeRejection(key, null, now);
        this.refreshBoard(key, now);
        results.push({ key, status: current ? 'updated' : 'created', version });
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
        // A key that only ever had refused rows leaves the board too.
        this.sql.exec('DELETE FROM gaps WHERE key = ?', key);
        this.sql.exec('DELETE FROM rejections WHERE key = ?', key);
        this.sql.exec('DELETE FROM board WHERE key = ?', key);
        this.forgetEdits(key);
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

  /** How many of this shard's products use a type, or are filed in a category. */
  countUsing(q: { type?: string; category?: string }): number {
    if (q.type)
      return this.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM products WHERE type = ?', q.type)
        .one().n;
    if (q.category)
      return this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM products
           WHERE EXISTS (SELECT 1 FROM json_each(json_extract(body, '$.categories')) WHERE value = ?)`,
          q.category,
        )
        .one().n;
    return 0;
  }

  /**
   * Takes down up to `limit` of this shard's products published in a deleted channel: their
   * documents, alias pointers and cards, and (through the changes queue) their listings and search
   * entries. Returns how many it took down; call again until it answers 0.
   */
  async forgetChannel(channel: string, limit: number): Promise<number> {
    // The channel is gone from the config by now: the next pass must not publish into it from a
    // copy fetched before (loadConfig trusts one for CONFIG_TTL_MS).
    this.config = undefined;
    const rows = this.sql
      .exec<{ key: string }>('SELECT key FROM published WHERE channel = ? LIMIT ?', channel, limit)
      .toArray();
    if (!rows.length) return 0;
    const at = Date.now();
    const deletes: string[] = [];
    const cards: string[] = [];
    const changes: ListingChange[] = [];
    for (const { key } of rows) {
      const state = this.publishedState(key).find((s) => s.channel === channel);
      if (!state) continue;
      for (const locale of state.locales) {
        deletes.push(paths.doc(DOC_FORMAT, channel, locale, key));
        cards.push(paths.card(DOC_FORMAT, channel, locale, state.uid));
      }
      for (const alias of state.aliases) deletes.push(paths.alias(DOC_FORMAT, channel, alias));
      changes.push({ channel, key, at, entry: null, left: state.categories, search: null });
    }
    for (let i = 0; i < deletes.length; i += 1000)
      await this.env.PUBLISHED.delete(deletes.slice(i, i + 1000));
    for (let i = 0; i < cards.length; i += 32)
      await Promise.all(cards.slice(i, i + 32).map((k) => this.env.CARDS.delete(k)));
    await sendChanges(this.env.CHANGES, changes);
    for (const { key } of rows) this.recordPublished(key, channel, null);
    return rows.length;
  }

  /** Queues every product for the publisher (a reindex), once each. Returns how many. */
  async republishAll(n: number): Promise<number> {
    this.shardNumber(n);
    const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM products').one().n;
    if (!count) return 0;
    // A product already waiting publishes its latest state anyway: don't queue it twice.
    this.sql.exec(
      'INSERT INTO outbox (key, urgent, forced) SELECT key, 0, 1 FROM products WHERE key NOT IN (SELECT key FROM outbox)',
    );
    // One already waiting is rewritten in full too.
    this.sql.exec('UPDATE outbox SET forced = 1');
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

  // --- The product editor's index ---

  /**
   * Rewrites a product's content gaps from its live data (none for a product whose type is gone),
   * and a conflict for each override the feed changed a value under. Its feed version and
   * overrides must be stored first.
   */
  private writeGaps(key: string, data: ProductData, config: CatalogConfig) {
    this.sql.exec(`DELETE FROM gaps WHERE key = ? AND ${IN_CONTENT}`, key);
    const overrides = this.overrideRows(key);
    const feed = overrides.length ? this.feedOf(key) : undefined;
    for (const o of overrides)
      if (feed && overrideConflict(feed, asOverride(o)))
        this.sql.exec(`INSERT INTO gaps VALUES (?, 'conflict', ?, ?, '')`, key, o.field, o.locale);
    const type = typeResolver(config)(data.type, data.typeVersion);
    if (!type) return;
    for (const g of contentGaps(data, type, config.channels))
      this.sql.exec(
        'INSERT OR IGNORE INTO gaps VALUES (?, ?, ?, ?, ?)',
        key,
        g.kind,
        g.field,
        g.locale,
        g.channel,
      );
  }

  /**
   * Records the row refused for `key` (replacing any before it), or clears it for null. A refusal
   * for a missing required attribute is its own kind: a stored product always has them. Returns
   * whether anything changed.
   */
  private writeRejection(
    key: string,
    r: (RejectedRow & { feed?: string }) | null,
    now: number,
  ): boolean {
    const had = this.sql
      .exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM rejections WHERE key = ?) AS e', key)
      .one().e;
    if (!r && !had) return false;
    this.sql.exec(
      `DELETE FROM gaps WHERE key = ? AND kind IN ('rejected', 'missing_required')`,
      key,
    );
    this.sql.exec('DELETE FROM rejections WHERE key = ?', key);
    if (!r) return true;
    const kind: GapKind = r.issues.every((i) => i.message === 'required')
      ? 'missing_required'
      : 'rejected';
    this.sql.exec(
      'INSERT INTO rejections VALUES (?, ?, ?, ?, ?, ?)',
      key,
      r.title,
      r.feed ?? null,
      r.row ?? null,
      JSON.stringify(r.issues),
      now,
    );
    this.sql.exec(`INSERT INTO gaps VALUES (?, ?, '', '', '')`, key, kind);
    return true;
  }

  /**
   * The product's card on the board: on Gaps while it has any (conflicts and refused rows count),
   * else on Staged while it has staged edits, else on Drafted while it has drafts to review, else on
   * Published for a day after its edits went live, else off the board. A card keeps the time it joined its column.
   */
  private refreshBoard(key: string, now: number) {
    const kinds = Object.fromEntries(
      this.sql
        .exec<{ kind: string; n: number }>(
          'SELECT kind, COUNT(*) AS n FROM gaps WHERE key = ? GROUP BY kind',
          key,
        )
        .toArray()
        .map((r) => [r.kind, r.n]),
    );
    const staged = this.sql
      .exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM staged WHERE key = ?) AS e', key)
      .one().e;
    const drafted = this.sql
      .exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM drafts WHERE key = ?) AS e', key)
      .one().e;
    const published =
      this.sql
        .exec<{ at: number | null }>('SELECT MAX(at) AS at FROM revisions WHERE key = ?', key)
        .one().at ?? 0;
    // Work in flight first, so a card moves right as it is worked on: staged edits, then drafts,
    // then gaps. The card still counts the gaps it has left.
    const col: BoardColumn | null = staged
      ? 'staged'
      : drafted
        ? 'drafted'
        : Object.keys(kinds).length
          ? 'gaps'
          : published > now - PUBLISHED_FOR_MS
            ? 'published'
            : null;
    if (!col) {
      this.sql.exec('DELETE FROM board WHERE key = ?', key);
      return;
    }
    const body = this.sql
      .exec<{ body: string }>('SELECT body FROM products WHERE key = ?', key)
      .toArray()[0]?.body;
    const title =
      (body ? anyText((JSON.parse(body) as ProductData).title) : '') ||
      (this.sql
        .exec<{ title: string }>('SELECT title FROM rejections WHERE key = ?', key)
        .toArray()[0]?.title ??
        '') ||
      key;
    this.sql.exec(
      `INSERT INTO board VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET title = excluded.title, kinds = excluded.kinds,
         at = CASE WHEN board.col = excluded.col THEN board.at ELSE excluded.at END,
         col = excluded.col`,
      key,
      col,
      title,
      JSON.stringify(kinds),
      now,
    );
  }

  /** This shard's board: products per column, gaps per kind, and whether its index is built. */
  boardCounts(): {
    columns: Record<string, number>;
    groups: Record<string, number>;
    kinds: Record<string, { gaps: number; products: number }>;
    built: boolean;
  } {
    const columns = Object.fromEntries(
      this.sql
        .exec<{ col: string; n: number }>(
          `SELECT col, COUNT(*) AS n FROM board WHERE col != 'published' OR at > ? GROUP BY col`,
          Date.now() - PUBLISHED_FOR_MS,
        )
        .toArray()
        .map((r) => [r.col, r.n]),
    );
    // Each product in Gaps once, in the first group that applies (`gapGroup`).
    const groups = this.sql
      .exec<Record<string, number>>(
        `SELECT COALESCE(SUM(c), 0) AS conflict, COALESCE(SUM(NOT c AND r), 0) AS rejected,
           COALESCE(SUM(NOT c AND NOT r AND q), 0) AS missing_required,
           COALESCE(SUM(NOT c AND NOT r AND NOT q), 0) AS missing
         FROM (SELECT json_type(kinds, '$.conflict') IS NOT NULL AS c,
                 json_type(kinds, '$.rejected') IS NOT NULL AS r,
                 json_type(kinds, '$.missing_required') IS NOT NULL AS q
               FROM board WHERE col = 'gaps')`,
      )
      .one();
    const kinds = Object.fromEntries(
      this.sql
        .exec<{ kind: string; gaps: number; products: number }>(
          'SELECT kind, COUNT(*) AS gaps, COUNT(DISTINCT key) AS products FROM gaps GROUP BY kind',
        )
        .toArray()
        .map((r) => [r.kind, { gaps: r.gaps, products: r.products }]),
    );
    const built =
      this.setting('gaps_built') === 1 ||
      !this.sql.exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM products) AS e').one().e;
    return { columns, groups, kinds, built };
  }

  /** Up to `limit` cards of a column after `cursor`, in key order, optionally with a gap kind. */
  boardPage(q: {
    column: BoardColumn;
    kind?: GapKind;
    cursor?: string;
    limit: number;
  }): BoardCard[] {
    return this.sql
      .exec<{
        key: string;
        col: string;
        title: string;
        kinds: string;
        at: number;
        feed: string | null;
        row: number | null;
        issues: string | null;
        rejected_at: number | null;
        staged: number;
        drafts: number;
        failure: string | null;
        locales: string;
      }>(
        `SELECT b.key, b.col, b.title, b.kinds, b.at, r.feed, r.row, r.issues, r.at AS rejected_at,
           (SELECT COUNT(*) FROM staged s WHERE s.key = b.key) AS staged,
           (SELECT MAX(failure) FROM staged s WHERE s.key = b.key) AS failure,
           (SELECT COUNT(*) FROM drafts d WHERE d.key = b.key) AS drafts,
           (SELECT json_group_array(DISTINCT g.locale) FROM gaps g
              WHERE g.key = b.key AND g.kind IN ('missing_title', 'missing_description', 'missing_attribute', 'missing_alt')) AS locales
         FROM board b LEFT JOIN rejections r ON r.key = b.key
         WHERE b.col = ?1 AND b.key > ?2
           AND (?3 IS NULL OR EXISTS (SELECT 1 FROM gaps g WHERE g.key = b.key AND g.kind = ?3))
           AND (b.col != 'published' OR b.at > ?5)
         ORDER BY b.key LIMIT ?4`,
        q.column,
        q.cursor ?? '',
        q.kind ?? null,
        q.limit,
        Date.now() - PUBLISHED_FOR_MS,
      )
      .toArray()
      .map((r) => ({
        key: r.key,
        title: r.title,
        column: r.col as BoardColumn,
        kinds: JSON.parse(r.kinds) as BoardCard['kinds'],
        rejection:
          r.issues === null
            ? null
            : {
                ...(r.feed ? { feed: r.feed } : {}),
                ...(r.row !== null ? { row: r.row } : {}),
                issues: JSON.parse(r.issues) as Issue[],
                at: r.rejected_at ?? 0,
              },
        locales: (JSON.parse(r.locales) as string[]).sort(),
        staged: r.staged,
        drafts: r.drafts,
        failure: r.failure,
        at: r.at,
      }));
  }

  /**
   * Recomputes the gaps of up to `limit` products after `cursor`, in key order, against the latest
   * config. Returns the cursor to go on from, null once the shard is done (its index then counts as
   * built), and how many products it read.
   */
  async refreshGaps(
    n: number,
    cursor: string | null,
    limit: number,
  ): Promise<{ next: string | null; products: number }> {
    this.shardNumber(n);
    const config = await this.loadConfig();
    const rows = this.sql
      .exec<{ key: string; body: string }>(
        'SELECT key, body FROM products WHERE key > ? ORDER BY key LIMIT ?',
        cursor ?? '',
        limit,
      )
      .toArray();
    const now = Date.now();
    const last = rows.length < limit;
    this.ctx.storage.transactionSync(() => {
      if (cursor === null) {
        this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('gaps_started', ?)`, now);
        // Until this pass is through, the index may still hold the old config's gaps.
        if (!last) this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('gaps_built', 0)`);
      }
      for (const r of rows) {
        this.writeGaps(r.key, JSON.parse(r.body) as ProductData, config);
        this.refreshBoard(r.key, now);
      }
      if (last) {
        // Rows for a key with neither a product nor a refusal (left by a Worker that predates the
        // index, during a rollback) go.
        const orphan =
          'key NOT IN (SELECT key FROM products) AND key NOT IN (SELECT key FROM rejections)';
        this.sql.exec(`DELETE FROM gaps WHERE ${orphan}`);
        this.sql.exec(`DELETE FROM board WHERE ${orphan}`);
        // Done, unless the config changed again after this pass began: then it runs once more.
        const job = this.rebuildJob();
        if (!job || job.requested <= (this.setting('gaps_started') ?? 0)) {
          this.sql.exec('DELETE FROM gap_rebuild');
          this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('gaps_built', 1)`);
        }
      }
    });
    return { next: last ? null : (rows.at(-1)?.key ?? null), products: rows.length };
  }

  private rebuildJob(): { requested: number; due: number; cursor: string | null } | undefined {
    return this.sql
      .exec<{ requested: number; due: number; cursor: string | null }>(
        'SELECT requested, due, cursor FROM gap_rebuild',
      )
      .toArray()[0];
  }

  /**
   * The channels changed: this shard's gaps may be wrong until they are recomputed. Marks the
   * index unbuilt and has the alarm rebuild it, GAP_REBUILD_DELAY_MS from now (0 in production;
   * tests rebuild themselves), page by page and resuming where it stopped, so a rebuild is never
   * lost to a request ending. A shard with no products has nothing to rebuild.
   */
  async markGapsStale(n: number): Promise<void> {
    this.shardNumber(n);
    this.config = undefined;
    if (!this.sql.exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM products) AS e').one().e) {
      this.sql.exec('DELETE FROM gap_rebuild');
      this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('gaps_built', 1)`);
      return;
    }
    const now = Date.now();
    const due = now + (Number(this.env.GAP_REBUILD_DELAY_MS) || 0);
    this.sql.exec('INSERT OR REPLACE INTO gap_rebuild VALUES (1, ?, ?, NULL)', now, due);
    this.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('gaps_built', 0)`);
    await this.scheduleAt(due);
  }

  /** Runs a due gap rebuild a page at a time until it is done or `deadline` passes. */
  private async rebuildPass(deadline: number) {
    for (;;) {
      const job = this.rebuildJob();
      if (!job || job.due > Date.now()) return;
      const r = await this.refreshGaps(this.setting('shard') ?? 0, job.cursor, GAP_PAGE);
      // Finished: refreshGaps cleared the job, or kept it (with a fresh start) if it was asked for
      // again meanwhile; look again either way.
      if (r.next === null) continue;
      // Only the pass this page belongs to: one asked for again meanwhile starts over.
      this.sql.exec('UPDATE gap_rebuild SET cursor = ? WHERE requested = ?', r.next, job.requested);
      if (Date.now() > deadline) return;
    }
  }

  // --- The product editor's edits ---

  /**
   * Stages edits, each checked against the product as it is live. Nothing goes live until
   * `publishStaged`; a later edit to the same field and locale replaces the earlier one.
   */
  async stageEdits(input: {
    shard: number;
    edits: StageEdit[];
    by: string;
  }): Promise<EditResult[]> {
    this.shardNumber(input.shard);
    const resolve = typeResolver(await this.loadConfig());
    const now = Date.now();
    const results: EditResult[] = [];
    this.ctx.storage.transactionSync(() => {
      const touched = new Set<string>();
      for (const e of input.edits) {
        const fail = (...issues: string[]) =>
          results.push({ key: e.key, ref: e.ref, ok: false, issues });
        const at = fieldKey(e.ref);
        if (!at) {
          fail('not an editable field');
          continue;
        }
        const body = this.sql
          .exec<{ body: string }>('SELECT body FROM products WHERE key = ?', e.key)
          .toArray()[0]?.body;
        if (!body) {
          fail('no such product');
          continue;
        }
        const live = JSON.parse(body) as ProductData;
        let value: string | null = null;
        if (e.op === 'clear') {
          const overridden = this.sql
            .exec<{ e: number }>(
              'SELECT EXISTS (SELECT 1 FROM overrides WHERE key = ? AND field = ? AND locale = ?) AS e',
              e.key,
              at.field,
              at.locale,
            )
            .one().e;
          if (!overridden) {
            fail('no edit to clear: it already shows the feed value');
            continue;
          }
        } else {
          const type = resolve(live.type, live.typeVersion);
          const issues = type
            ? editIssues(live, type, { ref: at.ref, value: e.value })
            : [`type ${live.type}@${live.typeVersion} is gone`];
          if (issues.length) {
            fail(...issues);
            continue;
          }
          value = e.value;
        }
        this.sql.exec(
          'INSERT OR REPLACE INTO staged VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          e.key,
          at.field,
          at.locale,
          e.op,
          value,
          fieldValue(live, at.ref),
          e.source === 'assistant' ? 'assistant' : 'person',
          input.by,
          now,
        );
        // Accepted, or written over: either way the draft is done with.
        this.sql.exec(
          'DELETE FROM drafts WHERE key = ? AND field = ? AND locale = ?',
          e.key,
          at.field,
          at.locale,
        );
        touched.add(e.key);
        results.push({ key: e.key, ref: at.ref, ok: true });
      }
      for (const key of touched) this.refreshBoard(key, now);
    });
    return results;
  }

  /** Drops staged edits: one field's, or with no `ref` all of a product's. Returns how many. */
  discardStaged(input: { shard: number; items: { key: string; ref?: FieldRef }[] }): number {
    this.shardNumber(input.shard);
    return this.discard('staged', input.items);
  }

  /** Drops drafts: one field's, or with no `ref` all of a product's. Returns how many. */
  discardDrafts(input: { shard: number; items: { key: string; ref?: FieldRef }[] }): number {
    this.shardNumber(input.shard);
    return this.discard('drafts', input.items);
  }

  private discard(table: 'staged' | 'drafts', items: { key: string; ref?: FieldRef }[]): number {
    const now = Date.now();
    let discarded = 0;
    this.ctx.storage.transactionSync(() => {
      const touched = new Set<string>();
      for (const { key, ref } of items) {
        const at = ref ? fieldKey(ref) : undefined;
        if (at === null) continue;
        discarded += at
          ? this.sql.exec(
              `DELETE FROM ${table} WHERE key = ? AND field = ? AND locale = ?`,
              key,
              at.field,
              at.locale,
            ).rowsWritten
          : this.sql.exec(`DELETE FROM ${table} WHERE key = ?`, key).rowsWritten;
        touched.add(key);
      }
      for (const key of touched) this.refreshBoard(key, now);
    });
    return discarded;
  }

  /**
   * Stores assistant drafts, each checked like an edit against the product as it is live, with the
   * live value it was drafted against. Status isn't drafted. Nothing is staged.
   */
  async putDrafts(input: {
    shard: number;
    drafts: DraftInput[];
    by: string;
  }): Promise<EditResult[]> {
    this.shardNumber(input.shard);
    const resolve = typeResolver(await this.loadConfig());
    const now = Date.now();
    const results: EditResult[] = [];
    this.ctx.storage.transactionSync(() => {
      const touched = new Set<string>();
      for (const d of input.drafts) {
        const fail = (...issues: string[]) =>
          results.push({ key: d.key, ref: d.ref, ok: false, issues });
        const at = fieldKey(d.ref);
        if (!at) {
          fail('not an editable field');
          continue;
        }
        if (at.ref.field === 'status') {
          fail('status is not drafted');
          continue;
        }
        if (typeof d.value !== 'string') {
          fail('a draft is text');
          continue;
        }
        const body = this.sql
          .exec<{ body: string }>('SELECT body FROM products WHERE key = ?', d.key)
          .toArray()[0]?.body;
        if (!body) {
          fail('no such product');
          continue;
        }
        const live = JSON.parse(body) as ProductData;
        const type = resolve(live.type, live.typeVersion);
        const issues = type
          ? editIssues(live, type, { ref: at.ref, value: d.value })
          : [`type ${live.type}@${live.typeVersion} is gone`];
        if (issues.length) {
          fail(...issues);
          continue;
        }
        this.sql.exec(
          'INSERT OR REPLACE INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          d.key,
          at.field,
          at.locale,
          d.value,
          fieldValue(live, at.ref),
          typeof d.model === 'string' ? d.model.slice(0, 200) : null,
          input.by,
          now,
        );
        touched.add(d.key);
        results.push({ key: d.key, ref: at.ref, ok: true });
      }
      for (const key of touched) this.refreshBoard(key, now);
    });
    return results;
  }

  /**
   * What publishing `key`'s staged edits would store, or why it can't: a value it changes was
   * changed since it was staged, or an edit no longer fits the product.
   */
  private planPublish(
    key: string,
    config: CatalogConfig,
  ):
    | { key: string; nothing: true }
    | { key: string; failure: string; staged: string }
    | {
        key: string;
        staged: string;
        live: ProductData;
        feed: ProductData;
        hash: string;
        before: { version: number; hash: string };
        overrides: OverrideRow[];
        revisions: PlannedRevision[];
        prevAliases: string[];
        aliases: string[];
      } {
    const staged = this.stagedRows(key);
    const snapshot = JSON.stringify(staged.map((s) => ({ ...s, failure: null })));
    if (!staged.length) return { key, nothing: true };
    const fail = (failure: string) => ({ key, failure, staged: snapshot });
    const before = this.head(key);
    const feed = this.feedOf(key);
    const body = this.sql
      .exec<{ body: string }>('SELECT body FROM products WHERE key = ?', key)
      .toArray()[0]?.body;
    if (!before || !feed || !body) return fail('the product was deleted');
    const live = JSON.parse(body) as ProductData;
    const type = typeResolver(config)(live.type, live.typeVersion);
    if (!type) return fail(`type ${live.type}@${live.typeVersion} is gone`);
    const overrides = new Map(
      this.overrideRows(key).map((o) => [`${o.field}\u0000${o.locale}`, o]),
    );
    const revisions: PlannedRevision[] = [];
    for (const s of staged) {
      const ref = refOf(s.field, s.locale);
      const now = fieldValue(live, ref);
      if (now !== s.seen) return fail(`${label(s.field, s.locale)} changed since it was staged`);
      const id = `${s.field}\u0000${s.locale}`;
      if (s.op === 'clear') overrides.delete(id);
      else {
        const issues = editIssues(live, type, { ref, value: s.value });
        if (issues.length) return fail(`${label(s.field, s.locale)}: ${issues.join('; ')}`);
        overrides.set(id, {
          field: s.field,
          locale: s.locale,
          value: s.value,
          base: fieldValue(feed, ref),
          source: s.source,
          who: s.who,
          at: s.at,
        });
      }
      revisions.push({
        field: s.field,
        locale: s.locale,
        op: s.op,
        value: s.op === 'set' ? s.value : fieldValue(feed, ref),
        previous: now,
        source: s.source,
        by: s.who,
      });
    }
    const next = applyOverrides(feed, [...overrides.values()].map(asOverride));
    // Every edit must show in the result: applyOverrides skips one that can't hold (the last
    // title, media the feed dropped), and that must not publish as if it had.
    for (const r of revisions)
      if (fieldValue(next, refOf(r.field, r.locale)) !== r.value)
        return fail(`${label(r.field, r.locale)} can't be set on the product as it is`);
    return {
      key,
      staged: snapshot,
      live: next,
      feed,
      hash: contentHash(next),
      before,
      overrides: [...overrides.values()],
      revisions,
      prevAliases: productAliases(live),
      aliases: productAliases(next),
    };
  }

  /**
   * Publishes the staged edits of `keys`, each product's all or none, through the same transaction
   * and outbox as every write. A refused product keeps its edits staged, with why. Re-sending a
   * request id returns the first answer and writes nothing.
   */
  async publishStaged(input: {
    shard: number;
    keys: string[];
    by: string;
    requestId: string;
    urgent?: boolean;
  }): Promise<PublishResult[]> {
    this.shardNumber(input.shard);
    const batchId = `publish:${input.requestId}`;
    const done = this.sql
      .exec<{ result: string }>('SELECT result FROM applied WHERE batch = ?', batchId)
      .toArray()[0];
    if (done) {
      // The same request again: its answer. A key it didn't have means the id was reused.
      const first = new Map((JSON.parse(done.result) as PublishResult[]).map((r) => [r.key, r]));
      return [...new Set(input.keys)].map(
        (key) =>
          first.get(key) ?? {
            key,
            status: 'failed',
            issues: ['this request id was used for other products; publish with a new one'],
          },
      );
    }
    const config = await this.loadConfig();
    const plans = [...new Set(input.keys)].map((key) => this.planPublish(key, config));
    const ready = plans.filter((p) => 'live' in p);
    const conflicts = await this.claimAliases(
      input.shard,
      ready.map((p) => ({ key: p.key, prev: p.prevAliases, next: p.aliases })),
    );

    const now = Date.now();
    const results: PublishResult[] = [];
    const releases: { owner: string; alias: string }[] = [];
    this.ctx.storage.transactionSync(() => {
      const refuse = (key: string, failure: string) => {
        this.sql.exec('UPDATE staged SET failure = ? WHERE key = ?', failure, key);
        this.refreshBoard(key, now);
        results.push({ key, status: 'failed', issues: [failure] });
      };
      for (const p of plans) {
        if ('nothing' in p) {
          results.push({ key: p.key, status: 'unchanged' });
          continue;
        }
        if (!('live' in p)) {
          refuse(p.key, p.failure);
          continue;
        }
        const taken = conflicts.get(p.key);
        // Written, or restaged, while this one claimed aliases: publish again to see it.
        const current = this.head(p.key);
        const stagedNow = JSON.stringify(
          this.stagedRows(p.key).map((s) => ({ ...s, failure: null })),
        );
        const raced = current?.version !== p.before.version || stagedNow !== p.staged;
        if (taken || raced) {
          // Give back what this one claimed, but not what the product as stored now holds.
          releases.push(...CatalogShard.releases(p.key, p.aliases, this.storedAliases(p.key)));
          if (!current)
            results.push({ key: p.key, status: 'failed', issues: ['the product was deleted'] });
          else if (stagedNow !== p.staged)
            // Restaged meanwhile: those edits haven't been tried, so they carry no failure.
            results.push({
              key: p.key,
              status: 'failed',
              issues: ['restaged meanwhile; publish again'],
            });
          else if (raced) refuse(p.key, 'changed by another write meanwhile; publish again');
          else refuse(p.key, (taken ?? []).map((i) => `${i.path} ${i.message}`).join('; '));
          continue;
        }
        const version = this.writeProduct(
          p.live,
          p.hash,
          current,
          { shard: input.shard, by: input.by, urgent: input.urgent, rev: config.rev },
          now,
        );
        releases.push(...CatalogShard.releases(p.key, p.prevAliases, p.aliases));
        this.sql.exec('DELETE FROM overrides WHERE key = ?', p.key);
        for (const o of p.overrides)
          this.sql.exec(
            'INSERT INTO overrides VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            p.key,
            o.field,
            o.locale,
            o.value,
            o.base,
            o.source,
            o.who,
            o.at,
          );
        this.storeFeed(p.key, p.feed, contentHash(p.feed), p.hash);
        for (const r of p.revisions)
          this.sql.exec(
            'INSERT INTO revisions (key, field, locale, op, value, previous, source, who, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            p.key,
            r.field,
            r.locale,
            r.op,
            r.value,
            r.previous,
            r.source,
            r.by,
            now,
          );
        this.sql.exec(
          `DELETE FROM revisions WHERE key = ?1 AND seq NOT IN
             (SELECT seq FROM revisions WHERE key = ?1 ORDER BY seq DESC LIMIT ?2)`,
          p.key,
          REVISIONS_KEPT,
        );
        this.sql.exec('DELETE FROM staged WHERE key = ?', p.key);
        this.writeGaps(p.key, p.live, config);
        this.refreshBoard(p.key, now);
        results.push({ key: p.key, status: 'published', version });
      }
      this.sql.exec('INSERT INTO applied VALUES (?, ?, ?)', batchId, now, JSON.stringify(results));
    });
    await this.releaseOn(input.shard, releases);
    await this.schedulePublish();
    return results;
  }

  /** Everything the editor's sheet shows for one product; null when there's no such product. */
  sheet(key: string): ProductSheet | null {
    const product = this.get(key);
    const feed = this.feedOf(key);
    if (!product || !feed) return null;
    const overrides: FieldOverride[] = this.overrideRows(key).map((o) => {
      const based = asOverride(o);
      return {
        ...based,
        feed: fieldValue(feed, based.ref),
        conflict: overrideConflict(feed, based),
        source: o.source,
        by: o.who,
        at: o.at,
      };
    });
    const staged: StagedEdit[] = this.stagedRows(key).map((s) => ({
      ref: refOf(s.field, s.locale),
      op: s.op,
      value: s.value,
      seen: s.seen,
      source: s.source,
      by: s.who,
      at: s.at,
      failure: s.failure,
    }));
    const gaps = this.sql
      .exec<Gap>(
        'SELECT kind, field, locale, channel FROM gaps WHERE key = ? ORDER BY kind, field, locale, channel',
        key,
      )
      .toArray();
    const r = this.sql
      .exec<{ feed: string | null; row: number | null; issues: string; at: number }>(
        'SELECT feed, row, issues, at FROM rejections WHERE key = ?',
        key,
      )
      .toArray()[0];
    const rejection: Rejection | null = r
      ? {
          ...(r.feed ? { feed: r.feed } : {}),
          ...(r.row !== null ? { row: r.row } : {}),
          issues: JSON.parse(r.issues) as Issue[],
          at: r.at,
        }
      : null;
    const revisions: Revision[] = this.sql
      .exec<{
        field: string;
        locale: string;
        op: 'set' | 'clear';
        value: string | null;
        previous: string | null;
        source: EditSource;
        who: string;
        at: number;
      }>(
        `SELECT field, locale, op, value, previous, source, who, at FROM revisions WHERE key = ?
         ORDER BY seq DESC`,
        key,
      )
      .toArray()
      .map((v) => ({
        ref: refOf(v.field, v.locale),
        op: v.op,
        value: v.value,
        previous: v.previous,
        source: v.source,
        by: v.who,
        at: v.at,
      }));
    const drafts: Draft[] = this.sql
      .exec<{
        field: string;
        locale: string;
        value: string;
        seen: string | null;
        model: string | null;
        who: string;
        at: number;
      }>(
        'SELECT field, locale, value, seen, model, who, at FROM drafts WHERE key = ? ORDER BY field, locale',
        key,
      )
      .toArray()
      .map((d) => {
        const ref = refOf(d.field, d.locale);
        return {
          ref,
          value: d.value,
          seen: d.seen,
          stale: fieldValue(product, ref) !== d.seen,
          model: d.model,
          by: d.who,
          at: d.at,
        };
      });
    return { product, feed, overrides, staged, drafts, gaps, rejection, revisions };
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
    await this.scheduleAt(Date.now());
  }

  /** Has the alarm fire by `at`: sooner than one already set for later. */
  private async scheduleAt(at: number) {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  /** Products waiting to publish (tests and the status page read it). */
  pending(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(DISTINCT key) AS n FROM outbox').one().n;
  }

  private hasPending(): boolean {
    return !!this.sql.exec<{ e: number }>('SELECT EXISTS (SELECT 1 FROM outbox) AS e').one().e;
  }

  /**
   * Publishes the outbox with up to PUBLISH_PASSES passes in flight, each on its own products, and
   * starts the next as soon as one finishes. A pass waits for the slowest of its publishers, so one
   * pass at a time left the shard idle behind its slowest write. A product with a pass in flight is
   * left for a later one, so its writes still never overlap or reorder. Hands over to a new alarm
   * after ALARM_WINDOW_MS; a failed pass fails the alarm (retried) once the others are done.
   */
  override async alarm() {
    this.sql.exec('DELETE FROM applied WHERE at < ?', Date.now() - APPLIED_TTL_MS);
    this.sql.exec(
      `DELETE FROM board WHERE col = 'published' AND at <= ?`,
      Date.now() - PUBLISHED_FOR_MS,
    );
    const deadline = Date.now() + ALARM_WINDOW_MS;
    const inFlight = new Set<string>();
    const running = new Set<Promise<void>>();
    let failure: unknown;
    for (;;) {
      while (running.size < PUBLISH_PASSES && failure === undefined && Date.now() < deadline) {
        const rows = this.nextPass(inFlight);
        if (!rows.length) break;
        const keys = [...new Set(rows.map((r) => r.key))];
        for (const k of keys) inFlight.add(k);
        const pass: Promise<void> = this.publishPass(rows, keys)
          .catch((err) => {
            failure ??= err;
          })
          .finally(() => {
            for (const k of keys) inFlight.delete(k);
            running.delete(pass);
          });
        running.add(pass);
      }
      if (!running.size) break;
      await Promise.race(running);
    }
    if (failure !== undefined) throw failure;
    await this.rebuildPass(deadline);
    const job = this.rebuildJob();
    if (this.hasPending()) await this.ctx.storage.setAlarm(Date.now());
    else if (job) await this.ctx.storage.setAlarm(Math.max(Date.now(), job.due));
  }

  /** The outbox rows of the next pass: up to PUBLISH_BATCH products, none of them in flight. */
  private nextPass(inFlight: Set<string>): OutboxRow[] {
    const rows = this.sql
      .exec<OutboxRow>(
        `SELECT seq, key, urgent, rev, forced FROM outbox
         WHERE key NOT IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT ?`,
        JSON.stringify([...inFlight]),
        PUBLISH_BATCH * 4,
      )
      .toArray();
    const keys = new Set([...new Set(rows.map((r) => r.key))].slice(0, PUBLISH_BATCH));
    return rows.filter((r) => keys.has(r.key));
  }

  private async publishPass(mine: OutboxRow[], keys: string[]): Promise<void> {
    const upTo = mine.at(-1)?.seq ?? 0;
    // The config these writes were validated against, or later; a row without a revision (a
    // removal, a reindex) takes the latest.
    const revs = mine.map((r) => r.rev);
    const config = await this.loadConfig(
      revs.includes(null) ? undefined : Math.max(...(revs as number[])),
    );
    const forced = new Set(mine.filter((r) => r.forced).map((r) => r.key));
    const changes = await publishKeys(this, keys, config, forced, this.setting('shard') ?? 0);
    // Listing indexes follow from these (listings.ts). Sent before the outbox rows go, so a crash
    // here republishes and sends them again; indexers order changes by `at`.
    await sendChanges(this.env.CHANGES, changes);
    // Urgent changes don't wait out the edge cache's minute: their tags go to catalog-edge's purge
    // queue, which it drains at the rate Cloudflare allows (a call of up to 100 tags at a time, so
    // a message carries that many). Sent after publishing, so a purge never refills from the old
    // document.
    const urgent = [...new Set(mine.filter((r) => r.urgent).map((r) => tags.product(r.key)))];
    const messages: { body: PurgeMessage }[] = [];
    for (let i = 0; i < urgent.length; i += PURGE_TAGS)
      messages.push({ body: { tags: urgent.slice(i, i + PURGE_TAGS) } });
    if (messages.length) await this.env.PURGE.sendBatch(messages);
    // Every outbox row of these keys up to the last one published is covered: later rows for the
    // same key (written meanwhile) republish the same, latest state on a later pass.
    this.sql.exec(
      'DELETE FROM outbox WHERE seq <= ? AND key IN (SELECT value FROM json_each(?))',
      upTo,
      JSON.stringify(keys),
    );
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

  publishedState(key: string): {
    channel: string;
    locales: string[];
    aliases: string[];
    uid: number;
    categories: string[];
  }[] {
    return this.sql
      .exec<{ channel: string; locales: string; aliases: string }>(
        'SELECT channel, locales, aliases FROM published WHERE key = ?',
        key,
      )
      .toArray()
      .map((r) => {
        const parsed = JSON.parse(r.aliases) as {
          uid: number;
          aliases: string[];
          categories?: string[];
        };
        return {
          channel: r.channel,
          locales: JSON.parse(r.locales) as string[],
          aliases: parsed.aliases,
          uid: parsed.uid,
          categories: parsed.categories ?? [],
        };
      });
  }

  recordPublished(
    key: string,
    channel: string,
    state: { locales: string[]; aliases: string[]; uid: number; categories: string[] } | null,
  ) {
    if (!state) this.sql.exec('DELETE FROM published WHERE key = ? AND channel = ?', key, channel);
    else
      this.sql.exec(
        'INSERT OR REPLACE INTO published VALUES (?, ?, ?, ?)',
        key,
        channel,
        JSON.stringify(state.locales),
        JSON.stringify({ uid: state.uid, aliases: state.aliases, categories: state.categories }),
      );
  }

  get publishEnv(): Env {
    return this.env;
  }
}
