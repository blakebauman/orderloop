/**
 * Catalog restore: the CatalogRestore Workflow, for an operator only. Nothing routes to it; it is
 * started with `wrangler workflows trigger orderloop-catalog-restore<suffix> --params '…'`
 * (docs/operations.md, "Catalog backups"). One of:
 *
 * - `{ "at": <ms or ISO time> }`: every object rewinds to that time with Durable Objects'
 *   point-in-time recovery (the last 30 days). The bookmarks are all found first, so a time out of
 *   reach changes nothing.
 * - `{ "bookmarks": { "<object>": "<bookmark>" } }`: the objects named rewind to those bookmarks:
 *   the `undo` of an earlier restore's output, which takes it back.
 * - `{ "backup": "<yyyy-mm-dd>" }`: every object's tables are replaced with that day's backup
 *   (backup.ts).
 *
 * A rewind restores a shard's `published` table too, which then no longer says what is in R2. So
 * each shard's is copied first (`restores/<instance>/`) and joined back after; `merge` names the
 * instances of earlier attempts whose copies to join as well. A backup load keeps the table as it is.
 *
 * Either way it ends as a reindex does, and more: channels the restore removed are taken down, the
 * category trees republished, and every product, and every key published before, republished in
 * full, so catalog-edge, listings, search and the order prices follow the restored catalog and
 * nothing it removed stays published. The output's `undo` holds each object's bookmark from before.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { DOC_FORMAT, PRODUCT_SHARDS, paths } from '@orderloop/core/product';
import { takeDownChannel } from './api';
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  type Backupable,
  type BackupRow,
  backupPrefix,
  chunkKey,
  copyTables,
  OBJECTS,
  readManifest,
  stubOf,
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

export type RestorePlan =
  | { mode: 'at'; at: number; merge: string[] }
  | { mode: 'bookmarks'; bookmarks: Record<string, string>; merge: string[] }
  | { mode: 'backup'; date: string };

/** What an operator asked for, checked before anything is touched; throws on anything else. */
export function parseRestore(params: unknown, now: number): RestorePlan {
  const p = (params ?? {}) as RestoreParams;
  const given = (['at', 'bookmarks', 'backup'] as const).filter((k) => p[k] !== undefined);
  if (given.length !== 1)
    throw new NonRetryableError('give exactly one of "at", "bookmarks" or "backup"');
  const merge = p.merge ?? [];
  if (
    !Array.isArray(merge) ||
    !merge.every((m) => typeof m === 'string' && /^[\w-]{1,100}$/.test(m))
  )
    throw new NonRetryableError('"merge" is a list of restore instance ids');
  if (p.backup !== undefined) {
    if (merge.length) throw new NonRetryableError('"merge" goes with "at" or "bookmarks"');
    if (typeof p.backup !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.backup))
      throw new NonRetryableError('"backup" is a date, yyyy-mm-dd');
    return { mode: 'backup', date: p.backup };
  }
  if (p.bookmarks !== undefined) {
    const entries =
      typeof p.bookmarks === 'object' && p.bookmarks ? Object.entries(p.bookmarks) : [];
    if (!entries.length) throw new NonRetryableError('"bookmarks" maps objects to bookmarks');
    for (const [object, bookmark] of entries) {
      if (!OBJECTS.includes(object))
        throw new NonRetryableError(`no catalog object ${object} (meta, or shard-0 to shard-63)`);
      if (typeof bookmark !== 'string' || !bookmark)
        throw new NonRetryableError(`${object}: a bookmark is a string`);
    }
    return { mode: 'bookmarks', bookmarks: Object.fromEntries(entries), merge };
  }
  const at = typeof p.at === 'number' ? p.at : typeof p.at === 'string' ? Date.parse(p.at) : NaN;
  if (!Number.isFinite(at)) throw new NonRetryableError('"at" is a time: milliseconds or ISO 8601');
  if (at >= now) throw new NonRetryableError('"at" must be in the past');
  if (at < now - PITR_DAYS * DAY_MS)
    throw new NonRetryableError(
      `"at" is more than ${PITR_DAYS} days ago: restore a backup instead`,
    );
  return { mode: 'at', at, merge };
}

/**
 * Rewinds one object: its storage is restored to `bookmark` when it next starts, which `reset`
 * makes now. Returns the bookmark that undoes it.
 */
export async function rewindObject(
  stub: Pick<Backupable, 'rewind' | 'reset'>,
  bookmark: string,
): Promise<string> {
  const undo = await stub.rewind(bookmark);
  // Resetting ends the object's session, the call to it included, so it answers with an error;
  // the next call starts on the restored storage.
  try {
    await stub.reset();
  } catch {}
  return undo;
}

const capturePrefix = (instance: string, object: string) => `restores/${instance}/${object}/`;

async function readChunk(bucket: R2Bucket, key: string): Promise<BackupRow[]> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`${key} is missing`);
  return (await object.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BackupRow);
}

/** Joins the `published` copies under each instance's prefix back into shard `n`. */
async function mergeCaptured(env: Env, instances: string[], n: number): Promise<number> {
  let rows = 0;
  for (const instance of instances) {
    let cursor: string | undefined;
    do {
      const page = await env.PUBLISHED.list({
        prefix: capturePrefix(instance, `shard-${n}`),
        cursor,
      });
      for (const o of page.objects)
        rows += await shard(env, n).mergePublished(await readChunk(env.PUBLISHED, o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return rows;
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

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;

export class CatalogRestore extends WorkflowEntrypoint<Env, RestoreParams> {
  override async run(event: Readonly<WorkflowEvent<RestoreParams>>, step: WorkflowStep) {
    const plan = parseRestore(event.payload, event.timestamp.getTime());
    const env = this.env;
    const shards = Array.from({ length: PRODUCT_SHARDS }, (_, n) => n);

    // What the catalog is before: its config revision and channels, and every object's bookmark.
    const before = await step.do('before', async () => {
      const m = meta(env);
      const [config, channels] = await Promise.all([m.getConfig(), m.channels()]);
      const undo: Record<string, string | null> = {};
      await Promise.all(
        OBJECTS.map(async (o) => {
          undo[o] = await stubOf(env, o).bookmark();
        }),
      );
      return {
        rev: config.rev,
        channels: channels.map((c) => ({ code: c.code, locales: c.locales })),
        undo,
      };
    });
    const undo = { ...before.undo };

    if (plan.mode === 'backup') {
      const chunks = await step.do('manifest', async () => {
        const manifest = await readManifest(env.PUBLISHED, plan.date);
        if (!manifest) throw new NonRetryableError(`no backup for ${plan.date}`);
        if (manifest.format !== BACKUP_FORMAT || manifest.shards !== PRODUCT_SHARDS)
          throw new NonRetryableError(
            `backup ${plan.date} is format ${manifest.format} of ${manifest.shards} shards`,
          );
        const missing = OBJECTS.filter((o) => !manifest.objects[o]);
        if (missing.length)
          throw new NonRetryableError(`backup ${plan.date} lacks ${missing.join(', ')}`);
        return Object.fromEntries(
          OBJECTS.map((o) => [
            o,
            Object.fromEntries(
              Object.entries(manifest.objects[o]?.tables ?? {}).map(([t, c]) => [t, c.chunks]),
            ),
          ]),
        );
      });
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
      for (const n of shards)
        await step.do(`capture shard-${n}`, RETRY, async () => {
          const stub = shard(env, n);
          const copied = await copyTables(
            env.PUBLISHED,
            capturePrefix(event.instanceId, `shard-${n}`),
            { backupPage: (_t, after, limit) => stub.publishedPage(after, limit) },
            ['published'],
          );
          return copied.published?.rows ?? 0;
        });
      for (const object of OBJECTS) {
        const target = targets[object];
        if (!target) continue;
        undo[object] = await step.do(`rewind ${object}`, RETRY, () =>
          rewindObject(stubOf(env, object), target),
        );
      }
      for (const n of shards)
        await step.do(`merge shard-${n}`, RETRY, () =>
          mergeCaptured(env, [event.instanceId, ...plan.merge], n),
        );
    }

    // Channels the restored config no longer has: take down what they published.
    const now = await step.do('channels after', async () =>
      (await meta(env).channels()).map((c) => c.code),
    );
    for (const gone of before.channels.filter((c) => !now.includes(c.code)))
      await step.do(`take down ${gone.code}`, RETRY, async () => {
        await env.PUBLISHED.delete(
          gone.locales.map((locale) => paths.categories(DOC_FORMAT, gone.code, locale)),
        );
        return takeDownChannel(env, gone.code);
      });

    const rev = await step.do('republish meta', RETRY, () => meta(env).afterRestore(before.rev));
    let republished = 0;
    for (const n of shards)
      republished += await step.do(`republish shard-${n}`, RETRY, () =>
        shard(env, n).afterRestore(n),
      );
    return {
      mode: plan.mode,
      undo,
      rev,
      republished,
      channelsRemoved: before.channels.map((c) => c.code).filter((c) => !now.includes(c)),
    };
  }
}
