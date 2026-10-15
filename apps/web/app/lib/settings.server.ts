/**
 * Workspace settings in D1 `workspace_settings`. Every page load checks them, and they change
 * rarely, so each isolate keeps what it read for a short while.
 */

import type { Principal } from '@orderloop/core';
import { workspaceSettings } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { audit } from './audit.server';
import { db } from './env.server';
import { isTwoFactorRequirement, type TwoFactorRequirement } from './two-factor';

const KEY = 'two_factor_required';
const CACHE_MS = 30_000;

let cached: { value: TwoFactorRequirement; at: number } | null = null;

/** Which roles must use two-factor sign-in; `off` until an admin sets it. */
export async function twoFactorRequirement(): Promise<TwoFactorRequirement> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, KEY))
    .get();
  const value = isTwoFactorRequirement(row?.value) ? row.value : 'off';
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
