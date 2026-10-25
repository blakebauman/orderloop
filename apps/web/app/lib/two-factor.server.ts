/**
 * Turning two-factor sign-in on and off. Each change asks for the person's password again, so a
 * borrowed browser can't switch it off or lock its owner out. Sign-in itself is in `auth.server.ts`.
 */

import { type Principal, secretContext } from '@orderloop/core';
import { recoveryCodes, users } from '@orderloop/db';
import { count, eq } from 'drizzle-orm';
import { endAccess, endedDetail } from './access.server';
import { audit } from './audit.server';
import { reauthenticate } from './auth.server';
import { sealSecret } from './data-key.server';
import { db } from './env.server';
import { twoFactorRequirement } from './settings.server';
import { TeamError } from './team.server';
import {
  fromBase32,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp';
import { mustUseTwoFactor, TWO_FACTOR_REQUIREMENTS } from './two-factor';

/** Whether the person has two-factor sign-in on, and how many recovery codes they have left. */
export async function twoFactorStatus(by: Principal) {
  if (by.kind !== 'user') return null;
  const [user, left] = await Promise.all([
    db().select({ enabledAt: users.totpEnabledAt }).from(users).where(eq(users.id, by.id)).get(),
    db().select({ n: count() }).from(recoveryCodes).where(eq(recoveryCodes.userId, by.id)).get(),
  ]);
  return { enabledAt: user?.enabledAt ?? null, recoveryLeft: left?.n ?? 0 };
}

export async function confirmPassword(by: Principal, given: string) {
  if (by.kind !== 'user')
    throw new TeamError('Only people with their own sign-in can use two-factor sign-in.');
  const user = await db().select().from(users).where(eq(users.id, by.id)).get();
  if (!user?.passwordHash || !(await reauthenticate(user.id, given, user.passwordHash)))
    throw new TeamError('Your password is not right.');
  return user;
}

/** A new secret to scan. Nothing is stored until a code from it is confirmed. */
export function startSetup(by: Principal) {
  const secret = newTotpSecret();
  return { secret, uri: otpauthUri(secret, by.email ?? by.name) };
}

async function replaceRecoveryCodes(userId: string) {
  const codes = newRecoveryCodes();
  const now = Date.now();
  await db().delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  await db()
    .insert(recoveryCodes)
    .values(
      await Promise.all(
        codes.map(async (c) => ({ codeHash: await hashRecoveryCode(c), userId, createdAt: now })),
      ),
    );
  return codes;
}

/** Turns two-factor sign-in on once a code from the new secret checks out; returns recovery codes. */
export async function enableTwoFactor(
  request: Request,
  by: Principal,
  input: { secret: string; code: string; password: string },
) {
  const user = await confirmPassword(by, input.password);
  if (user.totpEnabledAt) throw new TeamError('Two-factor sign-in is already on.');
  if (fromBase32(input.secret)?.length !== 20)
    throw new TeamError('Start the setup again: that secret is not one this page made.');
  const step = await verifyTotp(input.secret, input.code, Date.now());
  if (step === null)
    throw new TeamError(
      'That code doesn’t match. Enter the code your app shows now, and check the time on your phone.',
    );
  await db()
    .update(users)
    .set({
      totpSecret: await sealSecret(input.secret, secretContext.totp(user.id)),
      totpEnabledAt: Date.now(),
      totpLastStep: step,
    })
    .where(eq(users.id, user.id));
  const codes = await replaceRecoveryCodes(user.id);
  await audit(request, 'auth.two_factor_enabled', { actor: by, target: user.email });
  return codes;
}

export async function disableTwoFactor(request: Request, by: Principal, password: string) {
  const user = await confirmPassword(by, password);
  if (!user.totpEnabledAt) return;
  const required = await twoFactorRequirement();
  if (mustUseTwoFactor(by.role, required))
    throw new TeamError(
      `${TWO_FACTOR_REQUIREMENTS[required]} must use two-factor sign-in here, so it can’t be turned off. You can make new recovery codes instead.`,
    );
  await clear(user.id);
  await audit(request, 'auth.two_factor_disabled', { actor: by, target: user.email });
}

/** New recovery codes; the old ones stop working. */
export async function regenerateRecoveryCodes(request: Request, by: Principal, password: string) {
  const user = await confirmPassword(by, password);
  if (!user.totpEnabledAt) throw new TeamError('Turn on two-factor sign-in first.');
  const codes = await replaceRecoveryCodes(user.id);
  await audit(request, 'auth.recovery_codes_replaced', { actor: by, target: user.email });
  return codes;
}

/**
 * An operator turns off someone's two-factor sign-in, for a lost phone and no recovery codes.
 * They sign in with their password alone and can set it up again.
 */
export async function resetTwoFactor(request: Request, by: Principal, id: string) {
  if (id === by.id)
    throw new TeamError('Turn your own two-factor sign-in off on your Account page.');
  const user = await db()
    .select({ email: users.email, enabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, id))
    .get();
  if (!user) throw new TeamError('That person is no longer on the team.');
  // A lost phone or laptop: its passkeys go too, so whoever has it can't sign in, and so do the
  // sessions and connected apps it may still be signed in to.
  const ended = await endAccess(
    request,
    { id, email: user.email },
    { sessions: true, apps: true, passkeys: true },
  );
  if (!user.enabledAt && !ended.passkeys && !ended.sessions && !ended.apps) return;
  if (user.enabledAt) await clear(id);
  const { passkeys, ...rest } = endedDetail(ended);
  await audit(request, 'team.two_factor_reset', {
    actor: by,
    target: user.email,
    detail: { ...rest, ...(passkeys ? { passkeys: 'removed' } : {}) },
  });
}

async function clear(userId: string) {
  await db()
    .update(users)
    .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
    .where(eq(users.id, userId));
  await db().delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}
