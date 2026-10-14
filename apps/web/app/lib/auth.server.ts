/**
 * Who is signed in, and what they may do. Roles are in `@orderloop/core` (viewer < approver <
 * operator).
 *
 * - People sign in with an email and password from D1 `users`; the `__Host-ol_session` cookie holds
 *   a random token whose SHA-256 is a `sessions` row. Someone with two-factor sign-in on gets a
 *   `__Host-ol_2fa` cookie (a `sign_in_challenges` row) instead, and the session only once a code
 *   from their authenticator app, or a recovery code, checks out.
 * - The REST API takes `Authorization: Bearer ol_live_…`, an `api_tokens` row with its own role.
 * - `APP_PASSWORD`, when set, is a break-glass operator: sign in with the password and no email
 *   (the older HMAC cookie), or send it as the bearer token.
 * - With no `APP_PASSWORD` and no users (local development) everything is open, as an operator.
 *
 * Users carry an `external_sub` column for linking an outside identity later; sign-in through
 * an outside provider would create the same session row.
 */

import { env } from 'cloudflare:workers';
import {
  atLeast,
  type Principal,
  ROLE_LABELS,
  type Role,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SESSION_TOUCH_MS,
} from '@orderloop/core';
import {
  apiTokens,
  authFailures,
  recoveryCodes,
  sessions,
  signInChallenges,
  users,
} from '@orderloop/db';
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { data, redirect } from 'react-router';
import { audit, clientIp } from './audit.server';
import {
  API_TOKEN_PREFIX,
  hashPassword,
  normalizeEmail,
  randomToken,
  safeEqual,
  sha256Hex,
  verifyPassword,
} from './credentials';
import { db } from './env.server';
import { twoFactorRequirement } from './settings.server';
import { blockedFor, retryText, signInKeys, throttleKey, WINDOW_MS } from './throttle';
import { hashRecoveryCode, looksLikeTotp, verifyTotp } from './totp';
import { mustUseTwoFactor } from './two-factor';

const SESSION = '__Host-ol_session';
/** Between a correct password and a correct code, for someone with two-factor sign-in on. */
const CHALLENGE = '__Host-ol_2fa';
const CHALLENGE_MS = 10 * 60_000;
/** The shared-password cookie: an HMAC of APP_PASSWORD. */
const SHARED = 'ol_session';
const TOKEN_TOUCH_MS = 5 * 60_000;
const EXPIRED_AUDIT_MS = 60 * 60_000;

const OPEN: Principal = { kind: 'open', id: 'local', name: 'local', role: 'operator' };
const SHARED_PRINCIPAL: Principal = {
  kind: 'password',
  id: 'shared-password',
  name: 'operator',
  role: 'operator',
};

function password(): string | undefined {
  return (env as { APP_PASSWORD?: string }).APP_PASSWORD || undefined;
}

async function hmac(pw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('orderloop-session'));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, '');
}

function cookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

// Whether any user exists decides if a deployment without APP_PASSWORD is open. It only changes
// when the first user is added, so each isolate remembers it briefly.
let haveUsers: { value: boolean; at: number } | null = null;
async function anyUsers() {
  if (haveUsers && (haveUsers.value || Date.now() - haveUsers.at < 30_000)) return haveUsers.value;
  const row = await db().select({ n: count() }).from(users).get();
  haveUsers = { value: (row?.n ?? 0) > 0, at: Date.now() };
  return haveUsers.value;
}
export const forgetUserCount = () => {
  haveUsers = null;
};

export async function authEnabled(): Promise<boolean> {
  return !!password() || (await anyUsers());
}

/**
 * The id of the request's session (the SHA-256 its `sessions` row is keyed by), or undefined. The
 * agent proxy passes it on so the order page's socket can be checked against the live session.
 */
export async function sessionId(request: Request): Promise<string | undefined> {
  const token = cookie(request, SESSION);
  return token ? sha256Hex(token) : undefined;
}

/**
 * A browser caller. `twoFactorDue` marks a person whose role must use two-factor sign-in but who
 * hasn't set it up; `passwordChangeDue`, one still on a password an operator set. Until they put it
 * right, they may only use their Account page.
 */
export type Caller = Principal & { twoFactorDue?: true; passwordChangeDue?: true };

/** The signed-in person (or shared-password operator) for a browser request, or null. */
export async function principal(request: Request): Promise<Caller | null> {
  if (!(await authEnabled())) return OPEN;
  const token = cookie(request, SESSION);
  if (token) {
    const now = Date.now();
    const hash = await sha256Hex(token);
    const row = await db()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        totpEnabledAt: users.totpEnabledAt,
        passwordChangeDue: users.passwordChangeDue,
        seen: sql<number>`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hash),
          gt(sessions.expiresAt, now),
          // Idle too long: the session has ended even though its cookie hasn't.
          gt(sql`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`, now - SESSION_IDLE_MS),
          isNull(users.disabledAt),
        ),
      )
      .get();
    if (row) {
      const { seen, totpEnabledAt, passwordChangeDue, ...person } = row;
      if (now - seen > SESSION_TOUCH_MS)
        await db()
          .update(sessions)
          .set({ lastSeenAt: now, ip: clientIp(request) })
          .where(eq(sessions.tokenHash, hash));
      const role = person.role as Role;
      const due = !totpEnabledAt && mustUseTwoFactor(role, await twoFactorRequirement());
      return {
        kind: 'user',
        ...person,
        role,
        ...(due ? { twoFactorDue: true as const } : {}),
        ...(passwordChangeDue ? { passwordChangeDue: true as const } : {}),
      };
    }
  }
  const pw = password();
  const shared = cookie(request, SHARED);
  if (pw && shared && safeEqual(shared, await hmac(pw))) return SHARED_PRINCIPAL;
  return null;
}

// ── Throttling failed attempts (rules in throttle.ts, counts in D1 auth_failures) ──

/** Thrown when a client must wait before trying to authenticate again. */
export class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Too many failed attempts. ${retryText(retryAfterMs)}`);
  }
}

async function waitFor(keys: string[]) {
  const rows = await db().select().from(authFailures).where(inArray(authFailures.key, keys));
  return blockedFor(rows, Date.now());
}

/** Counts a failure against each key, starting a fresh window where the old one has ended. */
async function recordFailure(keys: string[]) {
  const now = Date.now();
  const expired = sql`${now} - ${authFailures.windowStart} >= ${WINDOW_MS}`;
  for (const key of keys)
    await db()
      .insert(authFailures)
      .values({ key, count: 1, windowStart: now })
      .onConflictDoUpdate({
        target: authFailures.key,
        set: {
          count: sql`case when ${expired} then 1 else ${authFailures.count} + 1 end`,
          windowStart: sql`case when ${expired} then ${now} else ${authFailures.windowStart} end`,
        },
      });
  // Failures are rare, so this is a cheap place to drop windows that ended a day ago.
  await db()
    .delete(authFailures)
    .where(lt(authFailures.windowStart, now - 86_400_000));
}

/**
 * The caller of a REST request: a bearer token, else the browser session. Guesses at the shared
 * APP_PASSWORD are throttled per address (throws `Throttled`); `ol_live_` tokens are random
 * 192-bit values, so they aren't, and a busy address can't lock out working integrations.
 */
export async function apiPrincipal(request: Request): Promise<Caller | null> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!bearer) return principal(request);
  if (!bearer.startsWith(API_TOKEN_PREFIX)) {
    const key = [throttleKey('api-ip', clientIp(request))];
    const wait = await waitFor(key);
    if (wait) {
      await audit(request, 'api.bearer_throttled');
      throw new Throttled(wait);
    }
    const pw = password();
    if (pw && safeEqual(bearer, pw)) return SHARED_PRINCIPAL;
    await recordFailure(key);
    await audit(request, 'api.bearer_failed');
    return null;
  }
  const row = await db()
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, await sha256Hex(bearer)), isNull(apiTokens.revokedAt)))
    .get();
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt !== null && row.expiresAt <= now) {
    // An integration retrying with an expired token is recorded at most hourly.
    if (!row.lastUsedAt || now - row.lastUsedAt > EXPIRED_AUDIT_MS) {
      await db().update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
      await audit(request, 'api.token_expired', {
        target: row.name,
        detail: { prefix: row.prefix, expiredAt: row.expiresAt },
      });
    }
    throw new TokenExpired(row.expiresAt);
  }
  if (!row.lastUsedAt || now - row.lastUsedAt > TOKEN_TOUCH_MS)
    await db().update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
  return { kind: 'token', id: row.id, name: `token:${row.name}`, role: row.role as Role };
}

/**
 * What an OAuth grant for an MCP client carries (see oauth.server.ts): who approved it and the
 * role they granted, which is never more than their own.
 */
export type GrantProps = { kind: Principal['kind']; id: string; role: Role };

const lower = (a: Role, b: Role): Role => (atLeast(a, b) ? b : a);

/**
 * The caller behind an OAuth grant, as they are now: null once the person is disabled or deleted,
 * the shared password is unset, or (for open local dev) sign-in has been turned on. The role is
 * the lower of what was granted and what they have now, so demoting someone also narrows the apps
 * they connected.
 */
export async function grantPrincipal(g: GrantProps): Promise<Caller | null> {
  if (g.kind === 'user') {
    const row = await db()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        totpEnabledAt: users.totpEnabledAt,
        passwordChangeDue: users.passwordChangeDue,
      })
      .from(users)
      .where(and(eq(users.id, g.id), isNull(users.disabledAt)))
      .get();
    if (!row) return null;
    const { totpEnabledAt, passwordChangeDue, ...person } = row;
    const own = person.role as Role;
    const due = !totpEnabledAt && mustUseTwoFactor(own, await twoFactorRequirement());
    return {
      kind: 'user',
      ...person,
      role: lower(g.role, own),
      ...(due ? { twoFactorDue: true as const } : {}),
      ...(passwordChangeDue ? { passwordChangeDue: true as const } : {}),
    };
  }
  if (g.kind === 'password')
    return password() ? { ...SHARED_PRINCIPAL, role: lower(g.role, SHARED_PRINCIPAL.role) } : null;
  if (g.kind === 'open') return (await authEnabled()) ? null : { ...OPEN, role: g.role };
  return null;
}

/** Thrown for a known API token past its expiry, so the caller hears why it stopped working. */
export class TokenExpired extends Error {
  constructor(readonly expiredAt: number) {
    super(
      `This API token expired on ${new Date(expiredAt).toISOString().slice(0, 10)}. An operator can create a new one on the Team page.`,
    );
  }
}

export const forbidden = (min: Role) =>
  `This needs the ${ROLE_LABELS[min]} role. Ask an operator to change your role on the Team page.`;

export const TWO_FACTOR_DUE =
  'Your role needs two-factor sign-in. Set it up on your Account page first.';

export const PASSWORD_CHANGE_DUE =
  'You are signed in with a temporary password. Choose your own on your Account page first.';

/** Why a caller may use only their Account page for now, or null when nothing is due. */
export const setupDue = (c: Caller): string | null =>
  c.passwordChangeDue ? PASSWORD_CHANGE_DUE : c.twoFactorDue ? TWO_FACTOR_DUE : null;

/** The page someone whose two-factor sign-in or own password is due may still use, to set it up. */
const SETUP_PATH = '/account';

/**
 * Loader/action guard. Not signed in: redirect to sign-in. Two-factor sign-in due: redirect to the
 * Account page to set it up. Signed in without `min`: 403. Returns the principal for audit fields
 * and for hiding what the role can't use.
 */
export async function requireUser(request: Request, min: Role = 'viewer'): Promise<Caller> {
  const p = await principal(request);
  const url = new URL(request.url);
  if (!p) throw redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  // Client navigations fetch loader data from `<path>.data`.
  if ((p.twoFactorDue || p.passwordChangeDue) && url.pathname.replace(/\.data$/, '') !== SETUP_PATH)
    throw redirect(SETUP_PATH);
  if (!atLeast(p.role, min))
    throw data({ ok: false, error: forbidden(min), need: min }, { status: 403 });
  return p;
}

const sessionCookie = (token: string) =>
  `${SESSION}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_MS / 1000}`;

// Compared against when the email is unknown, so a miss costs the same PBKDF2 work as a hit.
let decoy: Promise<string> | null = null;

/**
 * What a correct password leads to: a session, or (with two-factor sign-in on) the code step,
 * with the cookie to set either way.
 */
export type SignInResult = { cookie: string; twoFactor: boolean };

/**
 * Checks an email and password. Null for a wrong one. No email means the shared APP_PASSWORD.
 * Throws `Throttled`, before checking anything, when this person, this address or this account
 * has failed too often in the current window.
 */
export async function signIn(
  request: Request,
  email: string,
  given: string,
): Promise<SignInResult | null> {
  const keys = signInKeys(email, clientIp(request));
  const target = normalizeEmail(email) || null;
  const wait = await waitFor(keys);
  if (wait) {
    await audit(request, 'auth.sign_in_throttled', { target });
    throw new Throttled(wait);
  }
  const r = await checkCredentials(request, email, given);
  if ('reason' in r) {
    await recordFailure(keys);
    // The audit log says why; the person signing in only hears that it didn't match.
    await audit(request, 'auth.sign_in_failed', { target, detail: { reason: r.reason } });
    return null;
  }
  // Success clears this person-and-place count; the wider counts age out with their window.
  await db().delete(authFailures).where(eq(authFailures.key, keys[0]!));
  if (r.twoFactor) return { cookie: await startChallenge(r.principal.id), twoFactor: true };
  await audit(request, 'auth.sign_in', { actor: r.principal });
  return { cookie: r.cookie ?? (await startSession(request, r.principal.id)), twoFactor: false };
}

async function checkCredentials(
  request: Request,
  email: string,
  given: string,
): Promise<{ cookie?: string; principal: Principal; twoFactor: boolean } | { reason: string }> {
  if (!email.trim()) {
    const pw = password();
    if (!pw) return { reason: 'no workspace password is set' };
    if (!safeEqual(given, pw)) return { reason: 'wrong workspace password' };
    return {
      cookie: `${SHARED}=${await hmac(pw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      principal: SHARED_PRINCIPAL,
      twoFactor: false,
    };
  }
  const user = await db()
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .get();
  decoy ??= hashPassword(randomToken());
  const ok = await verifyPassword(given, user?.passwordHash ?? (await decoy));
  if (!user) return { reason: 'unknown email' };
  if (!user.passwordHash) return { reason: 'no password set' };
  if (!ok) return { reason: 'wrong password' };
  if (user.disabledAt) return { reason: 'disabled' };
  return {
    twoFactor: !!user.totpEnabledAt,
    principal: {
      kind: 'user',
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    },
  };
}

/** Creates a session for a user and returns the cookie to set. */
export async function startSession(request: Request, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db()
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(token),
      userId,
      createdAt: now,
      expiresAt: now + SESSION_MAX_MS,
      lastSeenAt: now,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
    });
  await db().update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return sessionCookie(token);
}

// ── The two-factor step ──

async function startChallenge(userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  // Sign-ins are rare enough to drop finished challenges here.
  await db().delete(signInChallenges).where(lte(signInChallenges.expiresAt, now));
  await db()
    .insert(signInChallenges)
    .values({
      tokenHash: await sha256Hex(token),
      userId,
      createdAt: now,
      expiresAt: now + CHALLENGE_MS,
    });
  return `${CHALLENGE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CHALLENGE_MS / 1000}`;
}

export const clearChallengeCookie = `${CHALLENGE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The person a live challenge belongs to: their password was right, their code is still due. */
export async function pendingChallenge(request: Request) {
  const token = cookie(request, CHALLENGE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      totpSecret: users.totpSecret,
      totpLastStep: users.totpLastStep,
    })
    .from(signInChallenges)
    .innerJoin(users, eq(users.id, signInChallenges.userId))
    .where(
      and(
        eq(signInChallenges.tokenHash, hash),
        gt(signInChallenges.expiresAt, Date.now()),
        isNull(users.disabledAt),
        isNotNull(users.totpEnabledAt),
      ),
    )
    .get();
  return row ? { ...row, challenge: hash } : null;
}

/**
 * Finishes a two-factor sign-in with a code from the authenticator app or a recovery code.
 * Returns the cookies to set, or null when there is no live challenge or the code is wrong.
 * Throws `Throttled` after too many wrong codes for this person.
 */
export async function verifySecondFactor(request: Request, code: string): Promise<string[] | null> {
  const pending = await pendingChallenge(request);
  if (!pending) return null;
  const person: Principal = {
    kind: 'user',
    id: pending.id,
    email: pending.email,
    name: pending.name,
    role: pending.role as Role,
  };
  const key = [throttleKey('two-factor', pending.id)];
  const wait = await waitFor(key);
  if (wait) {
    await audit(request, 'auth.two_factor_throttled', { target: pending.email });
    throw new Throttled(wait);
  }
  const method = looksLikeTotp(code) ? 'app' : 'recovery code';
  const ok =
    method === 'app' ? await useTotp(pending, code) : await useRecoveryCode(pending.id, code);
  if (!ok) {
    await recordFailure(key);
    await audit(request, 'auth.two_factor_failed', {
      target: pending.email,
      detail: { reason: `wrong ${method === 'app' ? 'code' : 'recovery code'}` },
    });
    return null;
  }
  await db().delete(signInChallenges).where(eq(signInChallenges.tokenHash, pending.challenge));
  await db().delete(authFailures).where(eq(authFailures.key, key[0]!));
  await audit(request, 'auth.sign_in', { actor: person, detail: { twoFactor: method } });
  if (method === 'recovery code') {
    const left =
      (
        await db()
          .select({ n: count() })
          .from(recoveryCodes)
          .where(eq(recoveryCodes.userId, pending.id))
          .get()
      )?.n ?? 0;
    await audit(request, 'auth.recovery_code_used', {
      actor: person,
      target: pending.email,
      detail: { left },
    });
  }
  return [await startSession(request, pending.id), clearChallengeCookie];
}

/** Accepts a code once: the step it matched must be later than the last one used. */
async function useTotp(
  user: { id: string; totpSecret: string | null; totpLastStep: number | null },
  code: string,
) {
  if (!user.totpSecret) return false;
  const step = await verifyTotp(user.totpSecret, code, Date.now(), user.totpLastStep);
  if (step === null) return false;
  // Conditional, so two requests racing with the same code can't both win.
  const r = await db()
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .run();
  return r.meta.changes > 0;
}

async function useRecoveryCode(userId: string, code: string) {
  const r = await db()
    .delete(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.codeHash, await hashRecoveryCode(code)),
        eq(recoveryCodes.userId, userId),
      ),
    )
    .run();
  return r.meta.changes > 0;
}

/** Ends the session server-side and returns cookies that clear both kinds. */
export async function signOut(request: Request): Promise<string[]> {
  const who = await principal(request);
  if (who && who.kind !== 'open') await audit(request, 'auth.sign_out', { actor: who });
  const token = cookie(request, SESSION);
  if (token)
    await db()
      .delete(sessions)
      .where(eq(sessions.tokenHash, await sha256Hex(token)));
  return [
    `${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${SHARED}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    clearChallengeCookie,
  ];
}

/** Who acted, for audit fields such as an approval's `by`. */
export const actor = (p: Principal) => p.email ?? p.name;
