/**
 * The business half of the audit log: what was done to orders, approvals, flows and webhooks, and
 * by whom, through whichever way in (the app, the REST API, a signed webhook, the assistant, MCP
 * or A2A). The web app and the engine both write these, through `auditRow`, into the same
 * `audit_events` table as the sign-in and team events.
 */

import type { Principal } from './roles';

export const BUSINESS_AUDIT_ACTIONS = {
  'order.started': 'Started an order',
  'order.cancelled': 'Cancelled an order',
  'order.event_delivered': 'Delivered an event',
  'approval.decided': 'Decided an approval',
  'flow.saved': 'Saved a flow draft',
  'flow.published': 'Published a flow',
  'webhook.subscribed': 'Subscribed to order events',
  'webhook.unsubscribed': 'Removed a webhook subscription',
  'stock.review_run': 'Ran the stock review',
} as const;

export type BusinessAuditAction = keyof typeof BUSINESS_AUDIT_ACTIONS;

/** Where an action came in. */
export const AUDIT_VIA = {
  app: 'the app',
  api: 'the REST API',
  webhook: 'a signed webhook',
  assistant: 'the assistant',
  mcp: 'MCP',
  a2a: 'A2A',
} as const;

export type AuditVia = keyof typeof AUDIT_VIA;

/** Who acted: a principal, or a machine such as an integration key. */
export type AuditActor = Pick<Principal, 'id' | 'name'> & {
  kind: string;
  email?: string;
  role?: string;
};

/** The row an audit event is stored as. Pure: each app inserts it with its own database. */
export function auditRow(
  id: string,
  action: string,
  e: {
    actor?: AuditActor | null;
    target?: string | null;
    detail?: Record<string, unknown> | null;
    ip?: string | null;
  },
  at = Date.now(),
) {
  return {
    id,
    at,
    action,
    actor: e.actor ? (e.actor.email ?? e.actor.name) : null,
    actorId: e.actor?.id ?? null,
    actorKind: e.actor?.kind ?? null,
    target: e.target ?? null,
    detail: e.detail ? JSON.stringify(e.detail) : null,
    ip: e.ip ?? null,
  };
}
