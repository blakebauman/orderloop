/**
 * The business half of the audit log: what was done to orders, approvals, flows and webhooks, and
 * by whom, through whichever way in (the app, the REST API, a signed webhook, the assistant, MCP
 * or A2A). The web app and the engine both write these, through `auditRow`, into the same
 * `audit_events` table as the sign-in and team events.
 */

import { fingerprintOf } from './api';
import type { Principal } from './roles';

export const BUSINESS_AUDIT_ACTIONS = {
  'order.started': 'Started an order',
  'order.cancelled': 'Cancelled an order',
  'order.event_delivered': 'Delivered an event',
  'approval.decided': 'Decided an approval',
  'flow.saved': 'Saved a flow draft',
  'flow.published': 'Published a flow',
  'flow.archived': 'Archived a flow draft',
  'flow.restored': 'Restored a flow draft',
  'webhook.subscribed': 'Subscribed to order events',
  'webhook.unsubscribed': 'Removed a webhook subscription',
  'webhook.rotated': 'Rotated a webhook signing secret',
  'stock.review_run': 'Ran the stock review',
  'catalog.products_written': 'Wrote catalog products',
  'catalog.products_deleted': 'Deleted catalog products',
  'catalog.type_saved': 'Saved a product type',
  'catalog.channel_saved': 'Saved a catalog channel',
  'catalog.categories_saved': 'Saved catalog categories',
  'catalog.feed_started': 'Started a catalog feed',
  'catalog.reindexed': 'Republished the catalog',
  'catalog.type_deleted': 'Deleted a product type',
  'catalog.channel_deleted': 'Deleted a catalog channel',
  'catalog.categories_deleted': 'Deleted catalog categories',
  'plugin.drafted': 'The assistant drafted a plugin',
  'plugin.draft_refused': 'The assistant’s plugin draft was refused',
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
  plugin: 'a plugin',
} as const;

export type AuditVia = keyof typeof AUDIT_VIA;

/** Who acted: a principal, or a machine such as an integration key. */
export type AuditActor = Pick<Principal, 'id' | 'name'> & {
  kind: string;
  email?: string;
  role?: string;
};

/** How long audit events are kept, unless the deployment sets `AUDIT_RETENTION_DAYS`. */
export const AUDIT_RETENTION_DAYS = 400;

/**
 * The shortest retention a deployment may set. The database refuses to delete a younger event
 * (a trigger in migration 0034), so this is also the floor for anything that deletes them.
 */
export const AUDIT_MIN_RETENTION_DAYS = 90;

/** The retention in days a deployment's `AUDIT_RETENTION_DAYS` asks for, kept to the floor. */
export function auditRetentionDays(value: string | undefined): number {
  const days = Number(value);
  if (!value || !Number.isInteger(days)) return AUDIT_RETENTION_DAYS;
  return Math.max(days, AUDIT_MIN_RETENTION_DAYS);
}

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

export type AuditRow = ReturnType<typeof auditRow>;

/** The last event in the chain: the one a new event follows. */
export type AuditHead = { seq: number; hash: string };

/** What the first event in a chain follows. */
export const AUDIT_GENESIS = 'genesis';

export type SealedAuditRow = AuditRow & { seq: number; prevHash: string; hash: string };

/** The hash an event is sealed with: SHA-256 of its fields, its place and the hash before it. */
export function auditHash(row: AuditRow & { seq: number; prevHash: string }): Promise<string> {
  return fingerprintOf({
    seq: row.seq,
    prevHash: row.prevHash,
    id: row.id,
    at: row.at,
    action: row.action,
    actor: row.actor,
    actorId: row.actorId,
    actorKind: row.actorKind,
    target: row.target,
    detail: row.detail,
    ip: row.ip,
  });
}

/**
 * Puts an event at the end of the chain: the next sequence number, the head's hash, and its own
 * hash over both. Changing, removing or reordering any sealed event breaks every hash after it.
 */
export async function sealAuditRow(row: AuditRow, head: AuditHead | null): Promise<SealedAuditRow> {
  const placed = { ...row, seq: (head?.seq ?? 0) + 1, prevHash: head?.hash ?? AUDIT_GENESIS };
  return { ...placed, hash: await auditHash(placed) };
}

export type AuditChainCheck =
  | { ok: true; checked: number; last: AuditHead | null }
  | { ok: false; checked: number; brokenAt: number; reason: string };

/**
 * Checks sealed events, in sequence order, against each other and against `after` (the event
 * just before them, or null to start at the first). Pruning removes the oldest events, so a check
 * of what is left starts from the first remaining event's own `prevHash` when `after` is omitted.
 */
export async function verifyAuditChain(
  rows: (AuditRow & { seq: number | null; prevHash: string | null; hash: string | null })[],
  after?: AuditHead | null,
): Promise<AuditChainCheck> {
  let prev: AuditHead | null | undefined = after;
  let checked = 0;
  for (const r of rows) {
    if (r.seq === null || r.prevHash === null || r.hash === null)
      return { ok: false, checked, brokenAt: r.seq ?? 0, reason: `event ${r.id} is not sealed` };
    if (prev !== undefined) {
      const seq = (prev?.seq ?? 0) + 1;
      const hash = prev?.hash ?? AUDIT_GENESIS;
      if (r.seq !== seq)
        return { ok: false, checked, brokenAt: r.seq, reason: `expected event ${seq} next` };
      if (r.prevHash !== hash)
        return { ok: false, checked, brokenAt: r.seq, reason: 'does not follow the event before' };
    }
    if ((await auditHash({ ...r, seq: r.seq, prevHash: r.prevHash })) !== r.hash)
      return { ok: false, checked, brokenAt: r.seq, reason: 'its contents changed' };
    prev = { seq: r.seq, hash: r.hash };
    checked++;
  }
  return { ok: true, checked, last: prev ?? null };
}
