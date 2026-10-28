/**
 * The engine's part of the deploy smoke test's write check (`HEALTH_WRITE_PATH`, reached as
 * `EngineApi.writeHealth`): its D1, its R2 and a Durable Object's SQLite each take a write, give
 * it back and lose it again. The object is `HealthProbe`, one of its own, so no order, cart or
 * assistant is ever touched.
 */

import { DurableObject } from 'cloudflare:workers';

/** A probe row older than this is one whose check stopped before its delete; the next clears it. */
const STALE_MS = 3_600_000;

/**
 * The write check's Durable Object: one (`healthProbe` in namespaces.ts), holding nothing between
 * checks. A row is written and made durable (`sync`), read back, deleted and made durable again,
 * so a deploy whose objects can't persist a write fails the check.
 */
export class HealthProbe extends DurableObject<Env> {
  async probe(id: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const at = Date.now();
    sql.exec('CREATE TABLE IF NOT EXISTS probes (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('INSERT INTO probes (id, at) VALUES (?, ?)', id, at);
    await this.ctx.storage.sync();
    const row = sql.exec<{ at: number }>('SELECT at FROM probes WHERE id = ?', id).toArray()[0];
    if (row?.at !== at) throw new Error('health probe row not read back');
    sql.exec('DELETE FROM probes WHERE id = ? OR at < ?', id, at - STALE_MS);
    await this.ctx.storage.sync();
  }
}

/** An object under `health/` written, read back and deleted (never under a locked prefix). */
export async function probeBucket(bucket: R2Bucket, id: string): Promise<void> {
  const key = `health/${id}`;
  const body = crypto.randomUUID();
  await bucket.put(key, body);
  try {
    const got = await bucket.get(key);
    if ((await got?.text()) !== body) throw new Error('health probe object not read back');
  } finally {
    await bucket.delete(key);
  }
}
