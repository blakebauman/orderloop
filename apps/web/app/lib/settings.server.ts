/**
 * Workspace settings in D1 `workspace_settings`. Every page load checks them, and they change
 * rarely, so each isolate keeps what it read for a short while.
 */

import { env } from 'cloudflare:workers';
import { APPROVAL_SEPARATION_KEY, type Principal } from '@orderloop/core';
import { workspaceSettings } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { audit } from './audit.server';
import { db } from './env.server';
import { readSsoSettings, type SsoSettings } from './sso';
import {
  DEFAULT_TWO_FACTOR,
  isTwoFactorRequirement,
  type TwoFactorRequirement,
} from './two-factor';

const KEY = 'two_factor_required';
const CACHE_MS = 30_000;

let cached: { value: TwoFactorRequirement; at: number } | null = null;

/**
 * Which roles must use two-factor sign-in. Until an admin chooses, operators and admins must: the
 * roles that can change orders, flows and the team.
 */
export async function twoFactorRequirement(): Promise<TwoFactorRequirement> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, KEY))
    .get();
  const value = isTwoFactorRequirement(row?.value) ? row.value : DEFAULT_TWO_FACTOR;
  cached = { value, at: Date.now() };
  return value;
}

export async function setTwoFactorRequirement(
  request: Request,
  by: Principal,
  next: TwoFactorRequirement,
) {
  const from = await twoFactorRequirement();
  if (from === next) return;
  const updatedBy = by.email ?? by.name;
  await db()
    .insert(workspaceSettings)
    .values({ key: KEY, value: next, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value: next, updatedAt: Date.now(), updatedBy },
    });
  cached = { value: next, at: Date.now() };
  await audit(request, 'team.two_factor_requirement', { actor: by, detail: { from, to: next } });
}

let separation: { value: boolean; at: number } | null = null;

/**
 * Whether whoever started an order is kept from deciding its approvals (`ownOrderRefusal`); off
 * until an admin turns it on. The engine reads the same row when a decision arrives.
 */
export async function approvalSeparation(): Promise<boolean> {
  if (separation && Date.now() - separation.at < CACHE_MS) return separation.value;
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY))
    .get();
  separation = { value: row?.value === 'on', at: Date.now() };
  return separation.value;
}

export async function setApprovalSeparation(request: Request, by: Principal, on: boolean) {
  if ((await approvalSeparation()) === on) return;
  const value = on ? 'on' : 'off';
  const updatedBy = by.email ?? by.name;
  await db()
    .insert(workspaceSettings)
    .values({ key: APPROVAL_SEPARATION_KEY, value, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: Date.now(), updatedBy },
    });
  separation = { value: on, at: Date.now() };
  await audit(request, 'team.approval_separation', {
    actor: by,
    detail: { from: on ? 'off' : 'on', to: value },
  });
}

const SSO_KEY = 'sso';
let sso: { value: SsoSettings; at: number } | null = null;

/** How single sign-on adds people and whether it is the only way in (`sso.ts`). */
export async function ssoSettings(): Promise<SsoSettings> {
  if (sso && Date.now() - sso.at < CACHE_MS) return sso.value;
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, SSO_KEY))
    .get();
  sso = { value: readSsoSettings(row?.value), at: Date.now() };
  return sso.value;
}

/**
 * Saves the SSO settings. `via` names how an admin who isn't signed in changed them: a setup code
 * recovering access turns SSO-only off, so a broken identity provider can't lock everyone out.
 */
export async function setSsoSettings(
  request: Request,
  by: Principal,
  next: SsoSettings,
  via?: 'setup code',
) {
  const from = await ssoSettings();
  if (JSON.stringify(from) === JSON.stringify(next)) return;
  const value = JSON.stringify(next);
  const updatedBy = by.email ?? by.name;
  await db()
    .insert(workspaceSettings)
    .values({ key: SSO_KEY, value, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: Date.now(), updatedBy },
    });
  sso = { value: next, at: Date.now() };
  await audit(request, 'team.sso_settings', {
    actor: by,
    detail: { from, to: next, ...(via ? { via } : {}) },
  });
}

/**
 * Whether passwords and passkeys are off right now: admins chose SSO-only and the deployment has
 * an identity provider. Without one, the saved choice can't lock anyone out.
 */
export async function ssoOnlyInEffect(): Promise<boolean> {
  const e = env as { OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string; OIDC_CLIENT_SECRET?: string };
  if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET) return false;
  return (await ssoSettings()).ssoOnly;
}
