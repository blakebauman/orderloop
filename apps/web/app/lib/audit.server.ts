/**
 * The security audit log: who signed in or failed to, and who changed the team or its tokens.
 * Writing never throws, so a logging problem can't block the action it records. Rows are kept 180
 * days. The vocabulary is `audit.ts`.
 */

import { newId, type Principal } from '@orderloop/core';
import { auditEvents } from '@orderloop/db';
import { and, desc, like, lt } from 'drizzle-orm';
import type { AuditAction, AuditGroup } from './audit';
import { db } from './env.server';

const KEEP_MS = 180 * 86_400_000;

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'local';

/** Who acted, as the audit trail names them. */
export const actorName = (p: Principal) => p.email ?? p.name;

export async function audit(
  request: Request,
  action: AuditAction,
  e: { actor?: Principal | null; target?: string | null; detail?: Record<string, unknown> } = {},
) {
  const now = Date.now();
  try {
    await db()
      .insert(auditEvents)
      .values({
        id: newId('aud'),
        at: now,
        action,
        actor: e.actor ? actorName(e.actor) : null,
        actorId: e.actor?.id ?? null,
        actorKind: e.actor?.kind ?? null,
        target: e.target ?? null,
        detail: e.detail ? JSON.stringify(e.detail) : null,
        ip: clientIp(request),
      });
    await db()
      .delete(auditEvents)
      .where(lt(auditEvents.at, now - KEEP_MS));
  } catch (err) {
    console.error('audit write failed', action, err);
  }
}

export type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

/** Newest first, `limit` at a time; `before` pages back, `group` filters by action prefix. */
export async function listAudit(f: { group?: AuditGroup; before?: number; limit?: number } = {}) {
  const rows = await db()
    .select()
    .from(auditEvents)
    .where(
      and(
        f.group ? like(auditEvents.action, `${f.group}.%`) : undefined,
        f.before ? lt(auditEvents.at, f.before) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.at))
    .limit(Math.min(Math.max(f.limit ?? 100, 1), 500));
  return rows.map((r) => ({
    ...r,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}
