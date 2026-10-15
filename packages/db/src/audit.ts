/**
 * Appending to the audit log's hash chain. The web app and the engine both write events, so two
 * writers can read the same head; the unique `seq` refuses the second, which waits a moment, reads
 * the new head and tries again.
 */

import { desc, isNotNull } from 'drizzle-orm';
import type { Db } from './index';
import { auditEvents } from './schema';

type Head = { seq: number; hash: string };
type Sealed = typeof auditEvents.$inferInsert & { seq: number; hash: string };

const ATTEMPTS = 20;

/** The newest sealed event, or null before the first. */
export async function auditHead(db: Db): Promise<Head | null> {
  const head = await db
    .select({ seq: auditEvents.seq, hash: auditEvents.hash })
    .from(auditEvents)
    .where(isNotNull(auditEvents.seq))
    .orderBy(desc(auditEvents.seq))
    .limit(1)
    .get();
  return head?.seq && head.hash ? { seq: head.seq, hash: head.hash } : null;
}

/** Inserts the event `seal` makes for the current head (`sealAuditRow` in core). */
export async function appendAudit(db: Db, seal: (head: Head | null) => Promise<Sealed>) {
  for (let attempt = 1; ; attempt++) {
    const row = await seal(await auditHead(db));
    try {
      await db.insert(auditEvents).values(row);
      return row;
    } catch (err) {
      // Drizzle wraps D1's error; the constraint is named in its cause.
      const text = `${err} ${(err as { cause?: unknown }).cause ?? ''}`;
      const lost = /UNIQUE constraint failed: audit_events\.seq/.test(text);
      if (!lost || attempt === ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
    }
  }
}
