/**
 * Catalog restore: the CatalogRestore Workflow, for an operator only. Nothing routes to it; it is
 * started with `wrangler workflows trigger orderloop-catalog-restore<suffix> --params '…'`
 * (docs/operations.md, "Restoring the catalog"). One of:
 *
 * - `{ "at": <ms or ISO time> }`: every object rewinds to that time with Durable Objects'
 *   point-in-time recovery (the last 30 days). The bookmarks are all found first, so a time out of
 *   reach changes nothing.
 * - `{ "bookmarks": { "<object>": "<bookmark>" } }`: the objects named rewind to those bookmarks:
 *   the `undo` of an earlier restore, which takes it back.
 * - `{ "backup": "<yyyy-mm-dd>" }`: every object's tables are replaced with that day's backup
 *   (backup.ts), once the whole backup has been checked against the tables as they are.
 *
 * A rewind restores a shard's `published` table too, which then no longer says what is in R2. So
 * each shard copies its own to `restores/<instance>/` in the same call that sets its rewind, with
 * nothing run between the two (`rewindInPlace`), and the copy is joined back after. A backup load
 * keeps the table as it is.
 *
 * Either way it ends as a reindex does, and more: every channel published somewhere (the shards'
 * `published` rows, R2's document tree) that the restored config lacks is taken down, the category
 * trees republished, and every product, and every key published before, republished in full, so
 * catalog-edge, listings, search and the order prices follow the restored catalog and nothing it
 * removed stays published.
 *
 * What the catalog was before (its revision, channels and each object's bookmark: the `undo`) is
 * kept at `restores/<instance>/before.json`. `merge` names earlier attempts: a run that finishes
 * one cut short takes their `before` (its own would be the half-restored catalog) and joins their
 * `published` copies too.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { DOC_FORMAT, PRODUCT_SHARDS } from '@orderloop/core/product';
import { takeDownChannel } from './api';
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  type Backupable,
  type BackupRow,
  backupPrefix,
  chunkKey,
  OBJECTS,
  putOnce,
  readManifest,
  stubOf,
  undoKey,
} from './backup';
import { meta, shard } from './config';

/** How far back Durable Objects' point-in-time recovery reaches. */
export const PITR_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RestoreParams = {
  at?: number | string;
  bookmarks?: Record<string, string>;
  backup?: string;
  merge?: string[];
};

export type RestorePlan = { merge: string[] } & (
  | { mode: 'at'; at: number }
  | { mode: 'bookmarks'; bookmarks: Record<string, string> }
  | { mode: 'backup'; date: string }
);

/** What an operator asked for, checked before anything is touched; throws on anything else. */
export function parseRestore(params: unknown, now: number): RestorePlan {
  const p = (params ?? {}) as RestoreParams;
  const given = (['at', 'bookmarks', 'backup'] as const).filter((k) => p[k] !== undefined);
  if (given.length !== 1) throw new Error('give exactly one of "at", "bookmarks" or "backup"');
  const merge = p.merge ?? [];
  if (
    !Array.isArray(merge) ||
    !merge.every((m) => typeof m === 'string' && /^[\w-]{1,100}$/.test(m))
  )
    throw new Error('"merge" is a list of restore instance ids');
  if (p.backup !== undefined) {
    if (typeof p.backup !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.backup))
      throw new Error('"backup" is a date, yyyy-mm-dd');
    return { mode: 'backup', date: p.backup, merge };
  }
  if (p.bookmarks !== undefined) {
    const entries =
      typeof p.bookmarks === 'object' && p.bookmarks ? Object.entries(p.bookmarks) : [];
    if (!entries.length) throw new Error('"bookmarks" maps objects to bookmarks');
    for (const [object, bookmark] of entries) {
      if (!OBJECTS.includes(object))
        throw new Error(`no catalog object ${object} (meta, or shard-0 to shard-63)`);
      if (typeof bookmark !== 'string' || !bookmark)
        throw new Error(`${object}: a bookmark is a string`);
    }
    return { mode: 'bookmarks', bookmarks: Object.fromEntries(entries), merge };
  }
  const at = typeof p.at === 'number' ? p.at : typeof p.at === 'string' ? Date.parse(p.at) : NaN;
  if (!Number.isFinite(at)) throw new Error('"at" is a time: milliseconds or ISO 8601');
  if (at >= now) throw new Error('"at" must be in the past');
  if (at < now - PITR_DAYS * DAY_MS)
    throw new Error(`"at" is more than ${PITR_DAYS} days ago: restore a backup instead`);
  return { mode: 'at', at, merge };
}

/** The catalog before a restore: what `before.json` keeps. */
export type Before = { rev: number; channels: string[]; undo: Record<string, string | null> };

export const restorePrefix = (instance: string) => `restores/${instance}/`;
const capturePrefix = (instance: string, object: string) => `${restorePrefix(instance)}${object}/`;
export const beforeKey = (instance: string) => `${restorePrefix(instance)}before.json`;

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? await object.json<T>() : null;
}

/**
 * This restore's `before`: the earliest of what it found and what the instances it merges kept
 * (in the order given, earliest first), so a run that finishes another one undoes to the catalog
 * as it was before either. Kept once: a retry reads it back.
 */
export async function keepBefore(
  bucket: R2Bucket,
  instance: string,
  merge: string[],
  found: Before,
): Promise<Before> {
  const before: Before = { rev: found.rev, channels: [...found.channels], undo: { ...found.undo } };
  for (const id of [...merge].reverse()) {
    const earlier = await readJson<Before>(bucket, beforeKey(id));
    if (!earlier) throw new Error(`no restore ${id} to merge (no ${beforeKey(id)})`);
    before.rev = Math.max(before.rev, earlier.rev);
    before.channels = [...new Set([...before.channels, ...earlier.channels])];
    for (const [o, b] of Object.entries(earlier.undo)) if (b) before.undo[o] = b;
  }
  await putOnce(bucket, beforeKey(instance), JSON.stringify(before));
  return (await readJson<Before>(bucket, beforeKey(instance))) as Before;
}

/**
 * Rewinds one object and makes sure it took: the object copies what it must and sets the rewind
 * (`rewindTo`, whose call fails as the object aborts), and the rewind counts only once the object
 * answers from a new session and its undo bookmark is stored, which it writes just before it
 * aborts. Anything else throws, so the step retries: a rewind set but never restarted into would
 * fire at some later eviction and undo everything after it. Returns the undo bookmark the object
 * kept (from its first attempt), as confirmation.
 */
export async function rewindObject(
  open: () => Pick<Backupable, 'session' | 'rewindTo'>,
  bucket: R2Bucket,
  bookmark: string,
  prefix: string,
): Promise<string> {
  const before = await open().session();
  let failure: unknown;
  try {
    await open().rewindTo(bookmark, prefix);
  } catch (err) {
    failure = err;
  }
  const kept = await bucket.head(undoKey(prefix));
  if (!kept) throw failure ?? new Error(`${prefix}: the rewind was never set`);
  if ((await open().session()) === before)
    throw new Error(`${prefix}: the rewind is set but the object hasn't restarted into it`);
  return kept.customMetadata?.undo ?? '';
}

async function readChunk(bucket: R2Bucket, key: string): Promise<BackupRow[]> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`${key} is missing`);
  return (await object.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BackupRow);
}

/** Joins the `published` copies each instance kept for shard `n` back into it. */
export async function mergeCaptured(env: Env, instances: string[], n: number): Promise<number> {
  let rows = 0;
  for (const instance of instances) {
    const prefix = `${capturePrefix(instance, `shard-${n}`)}published-`;
    let cursor: string | undefined;
    do {
      const page = await env.PUBLISHED.list({ prefix, cursor });
      for (const o of page.objects)
        rows += await shard(env, n).mergePublished(await readChunk(env.PUBLISHED, o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return rows;
}

/**
 * Checks a whole backup before anything is replaced: every table each object restores is in it,
 * none has a column the table no longer has, and every chunk is there with the rows the manifest
 * counts. Returns the chunks per object and table.
 */
async function verifyBackup(
  env: Env,
  date: string,
): Promise<Record<string, Record<string, number>>> {
  const manifest = await readManifest(env.PUBLISHED, date);
  if (!manifest) throw new Error(`no backup for ${date}`);
  if (manifest.format !== BACKUP_FORMAT || manifest.shards !== PRODUCT_SHARDS)
    throw new Error(`backup ${date} is format ${manifest.format} of ${manifest.shards} shards`);
  const [metaColumns, shardColumns] = await Promise.all([
    meta(env).backupColumns(),
    shard(env, 0).backupColumns(),
  ]);
  const problems: string[] = [];
  const heads: { object: string; table: string; key: string }[] = [];
  for (const object of OBJECTS) {
    const copy = manifest.objects[object];
    if (!copy) {
      problems.push(`${object} is missing`);
      continue;
    }
    const columns = object === 'meta' ? metaColumns : shardColumns;
    for (const table of object === 'meta' ? BACKUP_TABLES.meta : BACKUP_TABLES.shard) {
      const t = copy.tables[table];
      if (!t) {
        problems.push(`${object} has no ${table}`);
        continue;
      }
      const unknown = t.columns.filter((c) => !columns[table]?.includes(c));
      if (unknown.length) problems.push(`${object}.${table} has columns ${unknown.join(', ')}`);
      for (let c = 0; c < t.chunks; c++)
        heads.push({ object, table, key: chunkKey(`${backupPrefix(date)}${object}/`, table, c) });
    }
  }
  const rows = new Map<string, number>();
  for (let i = 0; i < heads.length; i += 50)
    await Promise.all(
      heads.slice(i, i + 50).map(async (h) => {
        const o = await env.PUBLISHED.head(h.key);
        if (!o) problems.push(`${h.key} is missing`);
        const id = `${h.object}.${h.table}`;
        rows.set(id, (rows.get(id) ?? 0) + Number(o?.customMetadata?.rows ?? 0));
      }),
    );
  for (const object of OBJECTS)
    for (const [table, t] of Object.entries(manifest.objects[object]?.tables ?? {}))
      if ((rows.get(`${object}.${table}`) ?? 0) !== t.rows && t.chunks)
        problems.push(
          `${object}.${table}: its chunks hold ${rows.get(`${object}.${table}`)} rows of ${t.rows}`,
        );
  if (problems.length)
    throw new Error(
      `backup ${date} can't be loaded, nothing was changed: ${problems.slice(0, 10).join('; ')}`,
    );
  return Object.fromEntries(
    OBJECTS.map((o) => [
      o,
      Object.fromEntries(
        Object.entries(manifest.objects[o]?.tables ?? {}).map(([t, c]) => [t, c.chunks]),
      ),
    ]),
  );
}

/** Replaces shard `n`'s tables with the backup's chunks. A retry starts over from the clear. */
async function loadShard(
  env: Env,
  date: string,
  n: number,
  chunks: Record<string, number>,
): Promise<number> {
  const stub = shard(env, n);
  await stub.restoreBegin(n);
  let rows = 0;
  for (const table of BACKUP_TABLES.shard)
    for (let c = 0; c < (chunks[table] ?? 0); c++)
      rows += await stub.restoreRows(
        table,
        await readChunk(env.PUBLISHED, chunkKey(`${backupPrefix(date)}shard-${n}/`, table, c)),
      );
  return rows;
}

async function loadMeta(env: Env, date: string, chunks: Record<string, number>): Promise<number> {
  const tables: Record<string, BackupRow[]> = {};
  for (const table of BACKUP_TABLES.meta) {
    tables[table] = [];
    for (let c = 0; c < (chunks[table] ?? 0); c++)
      tables[table].push(
        ...(await readChunk(env.PUBLISHED, chunkKey(`${backupPrefix(date)}meta/`, table, c))),
      );
  }
  return meta(env).restoreAll(tables);
}

/**
 * Channels published somewhere, in a shard's `published` rows or R2's document tree, that the
 * config lacks: what a restore must take down. Found from the data, so a run that finishes an
 * earlier one still finds what that one removed from the config.
 */
async function channelsGone(env: Env, known: string[]): Promise<string[]> {
  const kept = new Set((await meta(env).channels()).map((c) => c.code));
  const seen = new Set(known);
  const prefix = `docs/${DOC_FORMAT}/`;
  let cursor: string | undefined;
  do {
    const page = await env.PUBLISHED.list({ prefix, delimiter: '/', cursor });
    for (const p of page.delimitedPrefixes) seen.add(p.slice(prefix.length, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const shards = await Promise.all(
    Array.from({ length: PRODUCT_SHARDS }, (_, n) => shard(env, n).publishedChannels()),
  );
  for (const channels of shards) for (const c of channels) seen.add(c);
  return [...seen].filter((c) => !kept.has(c)).sort();
}

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;
// Steps that change nothing and fail only on what was asked for (an unknown merge, a bad backup):
// failed at once, with their reason. (A NonRetryableError would end the instance without it.)
const ONCE = { retries: { limit: 0, delay: '1 second' } } as const;

export class CatalogRestore extends WorkflowEntrypoint<Env, RestoreParams> {
  override async run(event: Readonly<WorkflowEvent<RestoreParams>>, step: WorkflowStep) {
    const plan = parseRestore(event.payload, event.timestamp.getTime());
    const env = this.env;
    const shards = Array.from({ length: PRODUCT_SHARDS }, (_, n) => n);

    // What the catalog is before: its config revision and channels, and every object's bookmark.
    const before = await step.do('before', ONCE, async () => {
      const m = meta(env);
      const [config, channels] = await Promise.all([m.getConfig(), m.channels()]);
      const undo: Record<string, string | null> = {};
      await Promise.all(
        OBJECTS.map(async (o) => {
          undo[o] = await stubOf(env, o).bookmark();
        }),
      );
      return keepBefore(env.PUBLISHED, event.instanceId, plan.merge, {
        rev: config.rev,
        channels: channels.map((c) => c.code),
        undo,
      });
    });

    try {
      if (plan.mode === 'backup') {
        // The whole backup is checked before anything is replaced.
        const chunks = await step.do('verify', ONCE, () => verifyBackup(env, plan.date));
        await step.do('load meta', RETRY, () => loadMeta(env, plan.date, chunks.meta ?? {}));
        for (const n of shards)
          await step.do(`load shard-${n}`, RETRY, () =>
            loadShard(env, plan.date, n, chunks[`shard-${n}`] ?? {}),
          );
      } else {
        // Every target first: a time out of reach fails here, before any object has moved.
        const targets =
          plan.mode === 'bookmarks'
            ? plan.bookmarks
            : await step.do('find bookmarks', RETRY, async () => {
                const found: Record<string, string> = {};
                await Promise.all(
                  OBJECTS.map(async (o) => {
                    found[o] = await stubOf(env, o).bookmarkFor(plan.at);
                  }),
                );
                return found;
              });
        for (const object of OBJECTS) {
          const target = targets[object];
          if (!target) continue;
          await step.do(`rewind ${object}`, RETRY, () =>
            rewindObject(
              () => stubOf(env, object),
              env.PUBLISHED,
              target,
              capturePrefix(event.instanceId, object),
            ),
          );
          const n = object === 'meta' ? null : Number(object.slice(6));
          if (n !== null)
            await step.do(`merge ${object}`, RETRY, () =>
              mergeCaptured(env, [...plan.merge, event.instanceId], n),
            );
        }
      }

      const gone = await step.do('channels after', () => channelsGone(env, before.channels));
      for (const code of gone)
        await step.do(`take down ${code}`, RETRY, () => takeDownChannel(env, code));

      const rev = await step.do('republish meta', RETRY, () => meta(env).afterRestore(before.rev));
      let republished = 0;
      for (const n of shards)
        republished += await step.do(`republish shard-${n}`, RETRY, () =>
          shard(env, n).afterRestore(n),
        );
      return { mode: plan.mode, undo: before.undo, rev, republished, channelsRemoved: gone };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${why}. What this restore changed stays changed: run it again with "merge": ["${event.instanceId}"] to finish it, or restore the "undo" bookmarks in ${beforeKey(event.instanceId)} to take it back`,
      );
    }
  }
}
