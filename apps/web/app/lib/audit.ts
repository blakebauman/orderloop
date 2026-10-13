/**
 * The audit log's vocabulary: every action it records, grouped for filtering, and a one-line
 * description of an event. Pure; `audit.server.ts` writes and reads the rows.
 */

import { ROLE_LABELS, type Role } from '@orderloop/core';

export const AUDIT_ACTIONS = {
  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Sign-in failed',
  'auth.sign_in_throttled': 'Sign-in refused: too many failures',
  'auth.sign_out': 'Signed out',
  'auth.password_changed': 'Changed own password',
  'team.first_operator': 'Created the first operator',
  'team.user_added': 'Added a person',
  'team.role_changed': 'Changed a role',
  'team.password_reset': 'Reset a password',
  'team.user_disabled': 'Disabled a person',
  'team.user_enabled': 'Enabled a person',
  'token.created': 'Created an API token',
  'token.revoked': 'Revoked an API token',
  'api.bearer_failed': 'API: wrong shared password',
  'api.bearer_throttled': 'API refused: too many wrong shared passwords',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** Filter groups, by action prefix. */
export const AUDIT_GROUPS = {
  auth: 'Sign-in',
  team: 'Team',
  token: 'API tokens',
  api: 'API access',
} as const;

export type AuditGroup = keyof typeof AUDIT_GROUPS;

export const isAuditGroup = (v: unknown): v is AuditGroup =>
  typeof v === 'string' && v in AUDIT_GROUPS;

export type AuditEvent = {
  action: string;
  actor: string | null;
  target: string | null;
  detail: Record<string, unknown> | null;
};

const role = (v: unknown) => ROLE_LABELS[v as Role] ?? String(v);

/** What happened, in one line: "Changed a role: ann@example.com, Viewer → Approver". */
export function describe(e: AuditEvent): string {
  const label = AUDIT_ACTIONS[e.action as AuditAction] ?? e.action;
  const d = e.detail ?? {};
  const parts: string[] = [];
  if (e.target) parts.push(e.target);
  if (e.action === 'team.role_changed' && d.from && d.to)
    parts.push(`${role(d.from)} → ${role(d.to)}`);
  else if (d.role) parts.push(role(d.role));
  if (typeof d.reason === 'string') parts.push(d.reason);
  return parts.length ? `${label}: ${parts.join(', ')}` : label;
}
