/**
 * Business audit events the engine sees first: decisions, events and cancels on the order page's
 * socket, and what the assistant, MCP and A2A do for someone. Same rows, chain and log lines as
 * the web app's (`audit.server.ts`). Writing never throws: a logging problem can't block the
 * action; a failure is logged as `{"type":"audit_write_failed",…}` to alert on.
 */

import {
  type AuditActor,
  auditRow,
  type BusinessAuditAction,
  newId,
  sealAuditRow,
} from '@orderloop/core';
import { appendAudit, createDb } from '@orderloop/db';

export async function recordAudit(
  env: Env,
  action: BusinessAuditAction,
  e: { actor: AuditActor; target?: string | null; detail?: Record<string, unknown> },
) {
  const row = auditRow(newId('aud'), action, e);
  try {
    const sealed = await appendAudit(createDb(env.DB), (head) => sealAuditRow(row, head));
    console.log(JSON.stringify({ type: 'audit_event', ...sealed }));
  } catch (err) {
    console.error(JSON.stringify({ type: 'audit_write_failed', action, error: String(err) }));
  }
}
