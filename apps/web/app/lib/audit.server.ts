/**
 * The audit log: who signed in or failed to, who changed the team or its tokens, and who did what
 * to orders, approvals, flows and webhooks (the engine writes the same rows for what the
 * assistant, MCP, A2A and the order page's socket do). Each event is sealed into the hash chain
 * (`appendAudit`) and logged as one JSON line, `{"type":"audit_event",…}`, which Logpush can carry
 * to a SIEM. Writing never throws, so a logging problem can't block the action it records; a
 * failure is logged as `{"type":"audit_write_failed",…}` to alert on. The engine's daily sweep
 * archives and prunes old events. The vocabulary is `audit.ts`.
 */

import {
  type AuditActor,
  auditRow,
  newId,
  type Principal,
  sealAuditRow,
  verifyAuditChain,
} from '@orderloop/core';
import { appendAudit, auditEvents } from '@orderloop/db';
import { and, asc, desc, eq, gt, isNotNull, like, lt } from 'drizzle-orm';
import type { AuditAction, AuditGroup } from './audit';
import { db } from './env.server';

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'local';

/** Who acted, as the audit trail names them. */
export const actorName = (p: Principal) => p.email ?? p.name;

export async function audit(
  request: Request,
  action: AuditAction,
  e: { actor?: AuditActor | null; target?: string | null; detail?: Record<string, unknown> } = {},
) {
  const row = auditRow(newId('aud'), action, { ...e, ip: clientIp(request) });
  try {
    const sealed = await appendAudit(db(), (head) => sealAuditRow(row, head));
    console.log(JSON.stringify({ type: 'audit_event', ...sealed }));
  } catch (err) {
    console.error(JSON.stringify({ type: 'audit_write_failed', action, error: String(err) }));
  }
}

export type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

/**
 * Newest first, `limit` at a time; `before` pages back, `group` filters by action prefix. With
 * `after` (a `seq`), sealed events after it, oldest first: the cursor an export or a SIEM pulls by.
 */
export async function listAudit(
  f: { group?: AuditGroup; before?: number; after?: number; limit?: number } = {},
) {
  const forward = f.after !== undefined;
  const rows = await db()
    .select()
    .from(auditEvents)
    .where(
      and(
        f.group ? like(auditEvents.action, `${f.group}.%`) : undefined,
        f.before ? lt(auditEvents.at, f.before) : undefined,
        forward ? and(isNotNull(auditEvents.seq), gt(auditEvents.seq, f.after!)) : undefined,
      ),
    )
    .orderBy(forward ? asc(auditEvents.seq) : desc(auditEvents.at))
    .limit(Math.min(Math.max(f.limit ?? 100, 1), 500));
  return rows.map((r) => ({
    ...r,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}

/** Sealed events checked per call; `next` continues from where one stopped. */
const VERIFY_BATCH = 2000;

/**
 * Checks the hash chain from just after `after` (a `seq`), or from the oldest event still kept
 * (pruned ones are in the R2 archive, which carries their hashes). `next` is set when there is
 * more to check.
 */
export async function verifyAudit(after?: number) {
  const anchor =
    after === undefined
      ? undefined
      : await db()
          .select({ seq: auditEvents.seq, hash: auditEvents.hash })
          .from(auditEvents)
          .where(eq(auditEvents.seq, after))
          .get();
  if (after !== undefined && !anchor?.hash)
    return { ok: false as const, checked: 0, brokenAt: after, reason: `no event ${after}` };
  const rows = await db()
    .select()
    .from(auditEvents)
    .where(
      and(isNotNull(auditEvents.seq), after === undefined ? undefined : gt(auditEvents.seq, after)),
    )
    .orderBy(asc(auditEvents.seq))
    .limit(VERIFY_BATCH);
  const check = await verifyAuditChain(
    rows,
    anchor ? { seq: anchor.seq!, hash: anchor.hash! } : undefined,
  );
  const next = check.ok && rows.length === VERIFY_BATCH ? check.last?.seq : undefined;
  return { ...check, ...(next ? { next } : {}) };
}
