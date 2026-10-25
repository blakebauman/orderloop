/**
 * The audit log's vocabulary: every action it records, grouped for filtering, and a one-line
 * description of an event. Pure; `audit.server.ts` writes and reads the rows.
 */

import {
  AUDIT_VIA,
  type AuditVia,
  BUSINESS_AUDIT_ACTIONS,
  ROLE_LABELS,
  type Role,
} from '@orderloop/core';
import { describeSso } from './sso';
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
  'auth.passkey_added': 'Added a passkey',
  'auth.passkey_removed': 'Removed a passkey',
  'auth.two_factor_throttled': 'Two-factor refused: too many wrong codes',
  'auth.two_factor_enabled': 'Turned on two-factor sign-in',
  'auth.two_factor_disabled': 'Turned off two-factor sign-in',
  'auth.recovery_codes_replaced': 'Made new recovery codes',
  'auth.recovery_code_used': 'Used a recovery code',
  'auth.sso_linked': 'Linked a sign-in from the identity provider',
  'auth.reauthenticated': 'Confirmed with single sign-on for a step-up',
  'team.first_admin': 'Created the first admin',
  'team.recovery_admin': 'Recovered admin access with a setup code',
  'team.setup_refused': 'Setup refused: wrong setup code',
  'team.user_added': 'Added a person',
  'team.user_updated': 'Changed a person’s name or email',
  'team.role_changed': 'Changed a role',
  'team.password_reset': 'Reset a password',
  'team.user_disabled': 'Disabled a person',
  'team.user_enabled': 'Enabled a person',
  'team.two_factor_reset': 'Reset two-factor sign-in',
  'team.two_factor_requirement': 'Changed who needs two-factor sign-in',
  'team.approval_separation': 'Changed whether people may approve orders they started',
  'team.sso_settings': 'Changed single sign-on settings',
  'team.scim_roles': 'Changed which groups give which role',
  'token.created': 'Created an API token',
  'token.revoked': 'Revoked an API token',
  'scim.token_created': 'Created the SCIM token',
  'scim.token_revoked': 'Revoked the SCIM token',
  'api.token_expired': 'API refused: expired token',
  'oauth.app_connected': 'Connected an app over MCP',
  'oauth.app_disconnected': 'Disconnected an app',
  'integration.created': 'Created an integration key',
  'integration.rotated': 'Rotated an integration key',
  'integration.revoked': 'Revoked an integration key',
  'ucp.settings': 'Changed agentic checkout settings',
  'ucp.platform_added': 'Let in an AI shopping platform',
  'ucp.platform_revoked': 'Revoked an AI shopping platform',
  'plugin.uploaded': 'Uploaded a plugin for review',
  'plugin.approved': 'Installed a plugin',
  'plugin.secret_set': 'Set a plugin’s secret',
  'plugin.disabled': 'Turned off a plugin',
  'plugin.enabled': 'Turned on a plugin',
  'plugin.rolled_back': 'Rolled back a plugin',
  'plugin.uninstalled': 'Uninstalled a plugin',
  'plugin.refused': 'Plugin change refused',
  'plugin.cases_run': 'Ran a drafted plugin’s test cases',
  'personal_data.exported': "Exported a person's data",
  'personal_data.erased': 'Erased a person from orders and accounts',
  ...BUSINESS_AUDIT_ACTIONS,
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** Filter groups, by action prefix. */
export const AUDIT_GROUPS = {
  auth: 'Sign-in',
  team: 'Team',
  token: 'API tokens',
  scim: 'SCIM provisioning',
  api: 'API access',
  oauth: 'Connected apps',
  integration: 'Integrations',
  ucp: 'Agentic checkout',
  order: 'Orders',
  approval: 'Approvals',
  cart: 'Carts',
  flow: 'Flows',
  webhook: 'Webhooks',
  stock: 'Stock review',
  promotion: 'Promotions',
  catalog: 'Catalog',
  plugin: 'Plugins',
  personal_data: 'Personal data',
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
  else if (e.action === 'team.sso_settings') {
    parts.push(describeSso(d.to));
    if (d.via === 'setup code') parts.push('by a setup code recovering access');
  } else if (e.action === 'team.approval_separation')
    parts.push(d.to === 'on' ? 'separated: no one approves their own orders' : 'not separated');
  else if (isTwoFactorRequirement(d.from) && isTwoFactorRequirement(d.to))
    parts.push(`${TWO_FACTOR_REQUIREMENTS[d.from]} → ${TWO_FACTOR_REQUIREMENTS[d.to]}`);
  else if (d.role) parts.push(role(d.role));
  if (typeof d.reason === 'string') parts.push(d.reason);
  if (typeof d.twoFactor === 'string') parts.push(`two-factor ${d.twoFactor}`);
  if (e.action.startsWith('auth.passkey_') && typeof d.name === 'string') parts.push(d.name);
  if (d.method === 'passkey') parts.push('with a passkey');
  if (d.method === 'sso') parts.push('with single sign-on');
  if (d.via === 'sso') parts.push('by single sign-on');
  if (d.via === 'scim') parts.push('by SCIM provisioning');
  if (typeof d.kept === 'string') parts.push(`kept: ${d.kept}`);
  if (e.action === 'team.user_disabled' && typeof d.sessions === 'number')
    parts.push(`${d.sessions} sessions, ${d.apps ?? 0} apps and ${d.tokens ?? 0} tokens ended`);
  if (e.action === 'scim.token_created' && d.replaced) parts.push('replacing the old one');
  if (d.passkeys === 'removed') parts.push('passkeys removed');
  if (e.action === 'auth.recovery_code_used' && typeof d.left === 'number')
    parts.push(`${d.left} left`);
  if (typeof d.decision === 'string') parts.push(d.decision);
  if (typeof d.event === 'string') parts.push(d.event);
  if (typeof d.version === 'number') parts.push(`v${d.version}`);
  if (e.action.startsWith('plugin.')) {
    if (typeof d.version === 'string') parts.push(`version ${d.version}`);
    if (typeof d.publisher === 'string') parts.push(`signed by ${d.publisher}`);
    if (typeof d.secret === 'string') parts.push(d.secret);
    if (d.personalData === true) parts.push('buyer details granted');
    if (typeof d.cases === 'string') parts.push(`${d.cases} cases pass`);
    if (typeof d.error === 'string') parts.push(d.error);
  }
  if (typeof d.via === 'string' && Object.hasOwn(AUDIT_VIA, d.via))
    parts.push(`via ${AUDIT_VIA[d.via as AuditVia]}`);
  return parts.length ? `${label}: ${parts.join(', ')}` : label;
}
