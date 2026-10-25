/**
 * Passkeys: WebAuthn credentials a person registers on their Account page and signs in with.
 * Signing in with one requires user verification (a fingerprint, face or device PIN), so it takes
 * the place of both the password and the code. Adding or removing one asks for the password again,
 * like the two-factor changes. The two-factor requirement is still met only by an authenticator
 * app, so password sign-in stays protected for everyone it covers.
 */

import type { Principal } from '@orderloop/core';
import { passkeyChallenges, passkeys, users } from '@orderloop/db';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, desc, eq, lt } from 'drizzle-orm';
import { audit, clientIp } from './audit.server';
import { recordFailure, startSession, Throttled, waitFor } from './auth.server';
import { randomToken, sha256Hex } from './credentials';
import { db } from './env.server';
import { ssoOnlyInEffect } from './settings.server';
import { TeamError } from './team.server';
import { throttleKey } from './throttle';
import { confirmPassword } from './two-factor.server';

const RP_NAME = 'OrderLoop';
const CHALLENGE_MS = 5 * 60_000;
/** Between asking for a passkey and the browser's answer, on the sign-in page. */
export const PASSKEY_COOKIE = '__Host-ol_pk';

/** The relying party is the host the person is on: each deployment's passkeys are its own. */
const party = (request: Request) => {
  const url = new URL(request.url);
  return { rpID: url.hostname, origin: url.origin };
};

/** The person's passkeys, newest first, without their keys. */
export async function listPasskeys(userId: string) {
  return db()
    .select({
      id: passkeys.id,
      name: passkeys.name,
      backedUp: passkeys.backedUp,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt));
}

async function putChallenge(id: string, challenge: string, userId: string | null) {
  const expiresAt = Date.now() + CHALLENGE_MS;
  await db()
    .insert(passkeyChallenges)
    .values({ id, challenge, userId, expiresAt })
    .onConflictDoUpdate({ target: passkeyChallenges.id, set: { challenge, userId, expiresAt } });
  // Challenges are short-lived: a cheap moment to drop the stale ones.
  await db().delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, Date.now()));
}

/** The challenge, removed so it can't be answered twice; null when missing or expired. */
async function takeChallenge(id: string) {
  const [row] = await db()
    .delete(passkeyChallenges)
    .where(eq(passkeyChallenges.id, id))
    .returning();
  return row && row.expiresAt > Date.now() ? row : null;
}

/** What the browser needs to create a passkey, after the person's password checks out. */
export async function registrationOptions(request: Request, by: Principal, password: string) {
  const user = await confirmPassword(by, password);
  const { rpID } = party(request);
  const existing = await db()
    .select({ id: passkeys.id, transports: passkeys.transports })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    // One passkey per authenticator: the browser skips any it already holds.
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: JSON.parse(p.transports) as string[],
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await putChallenge(`reg:${user.id}`, options.challenge, user.id);
  return options;
}

/** Stores the passkey the browser created, once its answer to the challenge checks out. */
export async function addPasskey(
  request: Request,
  by: Principal,
  response: RegistrationResponseJSON,
  name: string,
) {
  if (by.kind !== 'user')
    throw new TeamError('Only people with their own sign-in can add passkeys.');
  const c = await takeChallenge(`reg:${by.id}`);
  if (!c) throw new TeamError('That took too long. Add the passkey again.');
  const { rpID, origin } = party(request);
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new TeamError('That passkey could not be checked. Try again.');
  }
  if (!verified.verified) throw new TeamError('That passkey could not be checked. Try again.');
  const { credential, credentialBackedUp } = verified.registrationInfo;
  const label = name.trim().slice(0, 60) || 'Passkey';
  await db()
    .insert(passkeys)
    .values({
      id: credential.id,
      userId: by.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: JSON.stringify(credential.transports ?? []),
      name: label,
      backedUp: credentialBackedUp,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  await audit(request, 'auth.passkey_added', { actor: by, detail: { name: label } });
}

export async function removePasskey(request: Request, by: Principal, id: string, password: string) {
  await confirmPassword(by, password);
  const [gone] = await db()
    .delete(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, by.id)))
    .returning({ name: passkeys.name });
  if (!gone) throw new TeamError('That passkey is already gone.');
  await audit(request, 'auth.passkey_removed', { actor: by, detail: { name: gone.name } });
}

/** Removes every passkey a person has, as an admin's two-factor reset does: how many there were. */
export async function clearPasskeys(userId: string): Promise<number> {
  const gone = await db().delete(passkeys).where(eq(passkeys.userId, userId)).returning();
  return gone.length;
}

/** What the sign-in page asks the browser for, and the cookie that ties the answer to it. */
export async function signInOptions(request: Request) {
  const options = await generateAuthenticationOptions({
    rpID: party(request).rpID,
    userVerification: 'required',
  });
  const token = randomToken();
  await putChallenge(await sha256Hex(token), options.challenge, null);
  const cookie = `${PASSKEY_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CHALLENGE_MS / 1000}`;
  return { options, cookie };
}

export const clearPasskeyCookie = `${PASSKEY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/**
 * Signs in with the passkey the browser answered with, returning the session cookie, or null when
 * it doesn't check out. Failures count against the address like wrong passwords.
 */
export async function signInWithPasskey(
  request: Request,
  token: string | undefined,
  response: AuthenticationResponseJSON,
): Promise<string | null> {
  const key = [throttleKey('ip', clientIp(request))];
  const wait = await waitFor(key);
  if (wait) throw new Throttled(wait);
  const refuse = async (reason: string) => {
    await recordFailure(key);
    await audit(request, 'auth.sign_in_failed', { detail: { reason, method: 'passkey' } });
    return null;
  };
  if (await ssoOnlyInEffect()) return refuse('SSO only');
  const c = token ? await takeChallenge(await sha256Hex(token)) : null;
  if (!c) return refuse('passkey challenge expired');
  const row = await db()
    .select({
      passkey: passkeys,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        disabledAt: users.disabledAt,
      },
    })
    .from(passkeys)
    .innerJoin(users, eq(users.id, passkeys.userId))
    .where(eq(passkeys.id, response.id))
    .get();
  if (!row) return refuse('unknown passkey');
  if (row.user.disabledAt) return refuse('disabled');
  const { rpID, origin } = party(request);
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: row.passkey.id,
        publicKey: isoBase64URL.toBuffer(row.passkey.publicKey),
        counter: row.passkey.counter,
        transports: JSON.parse(row.passkey.transports) as string[],
      },
    });
  } catch {
    // Includes a counter that went backwards: a sign the key was copied.
    return refuse('passkey did not verify');
  }
  if (!verified.verified) return refuse('passkey did not verify');
  const now = Date.now();
  await db()
    .update(passkeys)
    .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: now })
    .where(eq(passkeys.id, row.passkey.id));
  const { disabledAt: _off, ...person } = row.user;
  const principal: Principal = { kind: 'user', ...person, role: person.role as Principal['role'] };
  await audit(request, 'auth.sign_in', { actor: principal, detail: { method: 'passkey' } });
  return startSession(request, person.id);
}
