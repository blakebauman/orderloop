/**
 * The audit log's vocabulary: every action it records, grouped for filtering, and a one-line
 * description of an event. Pure; `audit.server.ts` writes and reads the rows.
 */

import { ROLE_LABELS, type Role } from '@orderloop/core';
import { isTwoFactorRequirement, TWO_FACTOR_REQUIREMENTS } from './two-factor';

export const AUDIT_ACTIONS = {
  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Sign-in failed',
  'auth.sign_in_throttled': 'Sign-in refused: too many failures',
  'auth.sign_out': 'Signed out',
  'auth.password_changed': 'Changed own password',
  'auth.session_ended': 'Signed out a session',
  'auth.other_sessions_ended': 'Signed out everywhere else',
  'auth.two_factor_failed': 'Two-factor code wrong',
  'auth.two_factor_throttled': 'Two-factor refused: too many wrong codes',
  'auth.two_factor_enabled': 'Turned on two-factor sign-in',
  'auth.two_factor_disabled': 'Turned off two-factor sign-in',
  'auth.recovery_codes_replaced': 'Made new recovery codes',
  'auth.recovery_code_used': 'Used a recovery code',
  'team.first_admin': 'Created the first admin',
  'team.user_added': 'Added a person',
  'team.role_changed': 'Changed a role',
  'team.password_reset': 'Reset a password',
  'team.user_disabled': 'Disabled a person',
  'team.user_enabled': 'Enabled a person',
  'team.two_factor_reset': 'Reset two-factor sign-in',
  'team.two_factor_requirement': 'Changed who needs two-factor sign-in',
  'team.approval_separation': 'Changed whether people may approve orders they started',
  'token.created': 'Created an API token',
  'token.revoked': 'Revoked an API token',
  'api.bearer_failed': 'API: wrong shared password',
  'api.bearer_throttled': 'API refused: too many wrong shared passwords',
  'api.token_expired': 'API refused: expired token',
  'oauth.app_connected': 'Connected an app over MCP',
  'oauth.app_disconnected': 'Disconnected an app',
  'integration.created': 'Created an integration key',
  'integration.rotated': 'Rotated an integration key',
  'integration.revoked': 'Revoked an integration key',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** Filter groups, by action prefix. */
export const AUDIT_GROUPS = {
  auth: 'Sign-in',
  team: 'Team',
  token: 'API tokens',
  api: 'API access',
  oauth: 'Connected apps',
  integration: 'Integrations',
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
  else if (e.action === 'team.approval_separation')
    parts.push(d.to === 'on' ? 'separated: no one approves their own orders' : 'not separated');
  else if (isTwoFactorRequirement(d.from) && isTwoFactorRequirement(d.to))
    parts.push(`${TWO_FACTOR_REQUIREMENTS[d.from]} → ${TWO_FACTOR_REQUIREMENTS[d.to]}`);
  else if (d.role) parts.push(role(d.role));
  if (typeof d.reason === 'string') parts.push(d.reason);
  if (typeof d.twoFactor === 'string') parts.push(`two-factor ${d.twoFactor}`);
  if (e.action === 'auth.recovery_code_used' && typeof d.left === 'number')
    parts.push(`${d.left} left`);
  return parts.length ? `${label}: ${parts.join(', ')}` : label;
}
