/**
 * The D1 part of the deploy smoke test's write check (`HEALTH_WRITE_PATH` in @orderloop/core): the
 * web app and the engine each run it on their own binding.
 */

import { eq, lt, or } from 'drizzle-orm';
import type { Db } from './index';
import { healthProbes } from './schema';

/** A row older than this is one whose check stopped before its delete; the next check clears it. */
const STALE_MS = 3_600_000;

/** Writes a row under `id`, reads it back and deletes it; throws unless all three land. */
export async function probeDb(db: Db, id: string, now = Date.now()): Promise<void> {
  await db.insert(healthProbes).values({ id, at: now });
  const row = await db
    .select({ at: healthProbes.at })
    .from(healthProbes)
    .where(eq(healthProbes.id, id))
    .get();
  if (row?.at !== now) throw new Error('health probe row not read back');
  await db
    .delete(healthProbes)
    .where(or(eq(healthProbes.id, id), lt(healthProbes.at, now - STALE_MS)));
}
