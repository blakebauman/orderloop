/**
 * Catalog backups: a copy of the catalog's source of truth, its Durable Objects' SQLite storage, in
 * the catalog's own R2 bucket, so a deployment's products outlive the objects' 30-day point-in-time
 * recovery and can be exported.
 *
 * The CatalogBackup Workflow runs daily. One step per object (CatalogMeta, then every shard) pages
 * through each table that is data of record (`BACKUP_TABLES`) and writes a chunk per page,
 * `backups/<date>/<object>/<table>-<n>.ndjson`, a row a line, then `backups/<date>/manifest.json`
 * once every object is copied. Tables left out are rebuilt by a republish or are transient: a
 * shard's `outbox`, `applied` (batch ids, a week), `published` (what is in R2 now, which a restore
 * must keep) and `gap_rebuild` (a pending rebuild). The other Durable Objects hold no data of
 * record: listing indexes and search shards are rebuilt from the republish a restore ends with,
 * publishers keep nothing, and CatalogFeeds is the history of past imports, whose files expire in
 * 30 days anyway.
 *
 * `backups/` is under a bucket lock, which refuses to overwrite an object, so every write here
 * looks first and skips a key that exists (`putOnce`). A retried step resumes rather than starting
 * over: each chunk records the last rowid it holds, and the next page starts after it. A backup is
 * not a snapshot across pages (writes may land between them); the bookmark each object records
 * when its copy starts names an exact point to rewind to instead (restore.ts).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { DOC_FORMAT, PRODUCT_SHARDS } from '@orderloop/core/product';
import { meta, shard } from './config';

/** The tables each kind of object backs up, in the order a restore loads them. */
export const BACKUP_TABLES = {
  meta: ['types', 'channels', 'categories', 'settings'],
  shard: [
    'products',
    'aliases',
    'settings',
    'feed_rows',
    'overrides',
    'staged',
    'revisions',
    'drafts',
    'rejections',
    'gaps',
    'board',
  ],
} as const;

/** The manifest's shape; a restore refuses any other. */
export const BACKUP_FORMAT = 1;
/** Rows per chunk, at most. */
export const BACKUP_PAGE = 1000;
/** Bytes of rows per chunk, about: a page stops at the row that passes it. */
const PAGE_BYTES = 8 * 1024 * 1024;

export type BackupRow = Record<string, string | number | null>;
export type BackupPage = { columns: string[]; rows: BackupRow[]; last: number };
export type TableCopy = { rows: number; chunks: number; columns: string[] };
export type ObjectCopy = { bookmark: string | null; tables: Record<string, TableCopy> };
export type Manifest = {
  format: typeof BACKUP_FORMAT;
  date: string;
  finishedAt: string;
  docFormat: string;
  shards: number;
  objects: Record<string, ObjectCopy>;
};

/** What a backup or restore needs of an object; CatalogMeta and CatalogShard both serve it. */
export interface Backupable {
  backupPage(table: string, after: number, limit: number): Promise<BackupPage>;
  bookmark(): Promise<string | null>;
  bookmarkFor(at: number): Promise<string>;
  rewind(bookmark: string): Promise<string>;
  reset(): Promise<void>;
}

/** Every object backed up, by name: `meta`, then `shard-0` … `shard-63`. */
export const OBJECTS = ['meta', ...Array.from({ length: PRODUCT_SHARDS }, (_, n) => `shard-${n}`)];

export const shardOf = (object: string) =>
  object.startsWith('shard-') ? Number(object.slice(6)) : null;

export const tablesOf = (object: string): readonly string[] =>
  object === 'meta' ? BACKUP_TABLES.meta : BACKUP_TABLES.shard;

export function stubOf(env: Env, object: string): Backupable {
  const n = shardOf(object);
  if (object !== 'meta' && (n === null || !Number.isInteger(n) || n < 0 || n >= PRODUCT_SHARDS))
    throw new RangeError(`no catalog object ${object}`);
  return (n === null ? meta(env) : shard(env, n)) as unknown as Backupable;
}

export const backupPrefix = (date: string) => `backups/${date}/`;
export const manifestKey = (date: string) => `${backupPrefix(date)}manifest.json`;
export const chunkKey = (prefix: string, table: string, n: number) =>
  `${prefix}${table}-${n}.ndjson`;

// --- In the objects ---

/**
 * Up to `limit` rows of `table` after rowid `after`, in rowid order, stopping early past
 * PAGE_BYTES. `last` is the rowid to continue after. Only a table in `allowed` is read: the name
 * goes into the SQL.
 */
export function readPage(
  sql: SqlStorage,
  allowed: readonly string[],
  table: string,
  after: number,
  limit: number,
): BackupPage {
  if (!allowed.includes(table)) throw new RangeError(`${table} is not backed up`);
  const cursor = sql.exec<BackupRow & { _rowid: number }>(
    `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    after,
    Math.max(1, Math.min(limit, BACKUP_PAGE)),
  );
  const rows: BackupRow[] = [];
  let last = after;
  let bytes = 0;
  for (const { _rowid, ...row } of cursor) {
    rows.push(row);
    last = _rowid;
    bytes += JSON.stringify(row).length;
    if (bytes > PAGE_BYTES) break;
  }
  return { columns: cursor.columnNames.filter((c) => c !== '_rowid'), rows, last };
}

/** The columns `table` has now, refusing a backup row that names one it doesn't. */
function columnsOf(sql: SqlStorage, table: string, rows: BackupRow[]): string[] {
  const known = new Set(
    sql
      .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', table)
      .toArray()
      .map((c) => c.name),
  );
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const unknown = names.filter((c) => !known.has(c));
  if (unknown.length) throw new Error(`${table} has no column ${unknown.join(', ')}`);
  return names;
}

/**
 * Inserts backup rows into `table` (caller's transaction). A row whose key exists replaces it,
 * except where `upsert` says how to merge (settings keep the larger counter).
 */
export function insertRows(
  sql: SqlStorage,
  allowed: readonly string[],
  table: string,
  rows: BackupRow[],
  upsert?: string,
): number {
  if (!allowed.includes(table)) throw new RangeError(`${table} is not restored`);
  if (!rows.length) return 0;
  const columns = columnsOf(sql, table, rows);
  const statement = upsert
    ? `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ${upsert}`
    : `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  for (const row of rows) sql.exec(statement, ...columns.map((c) => row[c] ?? null));
  return rows.length;
}

/** The object's current bookmark, or null where its storage has none. */
export async function currentBookmark(storage: DurableObjectStorage): Promise<string | null> {
  try {
    return await storage.getCurrentBookmark();
  } catch {
    return null;
  }
}

// --- In the Workflow ---

/**
 * Writes `key` unless it exists, and returns what is stored there either way. The backups/ prefix
 * is locked against overwrites, so a retry must never put a key twice; a put that loses a race to
 * another attempt is taken as the object that won.
 */
export async function putOnce(
  bucket: R2Bucket,
  key: string,
  body: string,
  customMetadata?: Record<string, string>,
): Promise<R2Object> {
  const existing = await bucket.head(key);
  if (existing) return existing;
  try {
    const put = await bucket.put(key, body, { customMetadata });
    if (put) return put;
  } catch (err) {
    const won = await bucket.head(key);
    if (won) return won;
    throw err;
  }
  throw new Error(`${key} was not stored`);
}

/**
 * Copies `tables` of one object into chunks under `prefix`, resuming after the chunks already
 * there: each holds its last rowid and row count in its metadata.
 */
export async function copyTables(
  bucket: R2Bucket,
  prefix: string,
  stub: Pick<Backupable, 'backupPage'>,
  tables: readonly string[],
  limit = BACKUP_PAGE,
): Promise<Record<string, TableCopy>> {
  const out: Record<string, TableCopy> = {};
  for (const table of tables) {
    const copy: TableCopy = { rows: 0, chunks: 0, columns: [] };
    let after = 0;
    for (let n = 0; ; n++) {
      const key = chunkKey(prefix, table, n);
      const done = await bucket.head(key);
      if (done) {
        after = Number(done.customMetadata?.last);
        copy.rows += Number(done.customMetadata?.rows);
        copy.columns = done.customMetadata?.columns?.split(',') ?? copy.columns;
        copy.chunks++;
        continue;
      }
      const page = await stub.backupPage(table, after, limit);
      if (!copy.columns.length) copy.columns = page.columns;
      if (!page.rows.length) break;
      const stored = await putOnce(
        bucket,
        key,
        page.rows.map((r) => JSON.stringify(r)).join('\n'),
        {
          last: String(page.last),
          rows: String(page.rows.length),
          columns: page.columns.join(','),
        },
      );
      // Another attempt stored this chunk first: carry on from where its rows end.
      after = Number(stored.customMetadata?.last ?? page.last);
      copy.rows += Number(stored.customMetadata?.rows ?? page.rows.length);
      copy.chunks++;
    }
    out[table] = copy;
  }
  return out;
}

/**
 * One object's backup step: its bookmark (kept from the first attempt) and its tables. Returns
 * what the manifest records of it.
 */
export async function backupObject(
  bucket: R2Bucket,
  date: string,
  object: string,
  stub: Backupable,
  limit = BACKUP_PAGE,
): Promise<ObjectCopy> {
  const prefix = `${backupPrefix(date)}${object}/`;
  const bookmark = await stub.bookmark();
  const kept = await putOnce(bucket, `${prefix}bookmark.json`, JSON.stringify({ bookmark }), {
    bookmark: bookmark ?? '',
  });
  return {
    bookmark: kept.customMetadata?.bookmark || null,
    tables: await copyTables(bucket, prefix, stub, tablesOf(object), limit),
  };
}

export async function readManifest(bucket: R2Bucket, date: string): Promise<Manifest | null> {
  const object = await bucket.get(manifestKey(date));
  return object ? await object.json<Manifest>() : null;
}

/** The UTC date a backup started on names it. */
export const backupDate = (at: Date) => at.toISOString().slice(0, 10);

const COPY = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } } as const;

export class CatalogBackup extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep) {
    const date = backupDate(event.timestamp);
    const bucket = this.env.PUBLISHED;
    // A second run on the same day (a manual one beside the schedule) finds it done.
    const done = await step.do('check', async () => !!(await bucket.head(manifestKey(date))));
    if (done) return { date, skipped: true };
    const objects: Record<string, ObjectCopy> = {};
    for (const object of OBJECTS)
      objects[object] = await step.do(`copy ${object}`, COPY, () =>
        backupObject(bucket, date, object, stubOf(this.env, object)),
      );
    const rows = await step.do('manifest', async () => {
      const manifest: Manifest = {
        format: BACKUP_FORMAT,
        date,
        finishedAt: new Date().toISOString(),
        docFormat: DOC_FORMAT,
        shards: PRODUCT_SHARDS,
        objects,
      };
      await putOnce(bucket, manifestKey(date), JSON.stringify(manifest), {
        format: String(BACKUP_FORMAT),
      });
      return Object.values(objects).reduce(
        (sum, o) => sum + Object.values(o.tables).reduce((s, t) => s + t.rows, 0),
        0,
      );
    });
    return { date, objects: OBJECTS.length, rows };
  }
}
