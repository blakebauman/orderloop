/**
 * The catalog's part of the deploy smoke test's write check (`CatalogApi.writeHealth`): a row
 * through CatalogMeta's SQLite and one shard's, and an object through the published bucket. Each
 * write goes to a place of its own (a `health_probes` table, a `health/` key) that no product,
 * outbox, backup or catalog-edge route reads, and is gone again before the check answers.
 */

/** A probe row older than this is one whose check stopped before its delete; the next clears it. */
const STALE_MS = 3_600_000;

/**
 * A row written to an object's own `health_probes` table and made durable (`sync`), read back,
 * deleted and made durable again. Called inside the object; it awaits nothing but its own storage,
 * so a shard never waits on another shard here.
 */
export async function probeStorage(storage: DurableObjectStorage, id: string): Promise<void> {
  const sql = storage.sql;
  const at = Date.now();
  sql.exec('CREATE TABLE IF NOT EXISTS health_probes (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  sql.exec('INSERT INTO health_probes (id, at) VALUES (?, ?)', id, at);
  await storage.sync();
  const row = sql
    .exec<{ at: number }>('SELECT at FROM health_probes WHERE id = ?', id)
    .toArray()[0];
  if (row?.at !== at) throw new Error('health probe row not read back');
  sql.exec('DELETE FROM health_probes WHERE id = ? OR at < ?', id, at - STALE_MS);
  await storage.sync();
}

/**
 * An object under `health/` written, read back and deleted. catalog-edge reads only the keys the
 * publisher writes (`paths`), and the bucket's lock covers `backups/` alone.
 */
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
