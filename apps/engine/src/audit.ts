/**
 * Business audit events the engine sees first: decisions, events and cancels on the order page's
 * socket, and what the assistant, MCP and A2A do for someone. Same rows as the web app's
 * (`auditRow` in core). Writing never throws: a logging problem can't block the action.
 */

import { type AuditActor, auditRow, type BusinessAuditAction, newId } from '@orderloop/core';
import { auditEvents, createDb } from '@orderloop/db';

export async function recordAudit(
  env: Env,
  action: BusinessAuditAction,
  e: { actor: AuditActor; target?: string | null; detail?: Record<string, unknown> },
) {
  try {
    await createDb(env.DB)
      .insert(auditEvents)
      .values(auditRow(newId('aud'), action, e));
  } catch (err) {
    console.error('audit write failed', action, err);
  }
}
