/**
 * Who is signed in, and what they may do. Roles are in `@orderloop/core` (viewer < approver <
 * operator < admin).
 *
 * - People sign in with an email and password from D1 `users`; the `__Host-ol_session` cookie holds
 *   a random token whose SHA-256 is a `sessions` row. Someone with two-factor sign-in on gets a
 *   `__Host-ol_2fa` cookie (a `sign_in_challenges` row) instead, and the session only once a code
 *   from their authenticator app, or a recovery code, checks out.
 * - The REST API takes `Authorization: Bearer ol_live_…`, an `api_tokens` row with its own role.
 * - There is no shared password. A new deployment's first admin comes from its one-time setup
 *   code (`setup.server.ts`); with no users on localhost (local development) everything is open,
 *   as an admin.
 *
 * - With single sign-on set up (`sso.server.ts`), people can also sign in through the workspace's
 *   identity provider, linked by `users.external_sub`; it starts the same session row. With
 *   SSO-only on, passwords and passkeys are refused, and two-factor sign-in is the provider's job.
 */

import {
  atLeast,
  type Principal,
  ROLE_LABELS,
  type Role,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SESSION_TOUCH_MS,
  secretContext,
  sessionIdleMs,
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
  sha256Hex,
  verifyPassword,
} from './credentials';
import { openSecret } from './data-key.server';
import { DEMO_USER, isDemo } from './demo.server';
import { afterResponse, db } from './env.server';
import { isLocalHost } from './origin';
import { ssoOnlyInEffect, twoFactorRequirement } from './settings.server';
import { blockedFor, retryText, signInKeys, throttleKey, WINDOW_MS } from './throttle';
import { hashRecoveryCode, looksLikeTotp, verifyTotp } from './totp';
import { mustUseTwoFactor } from './two-factor';

const SESSION = '__Host-ol_session';
/** Between a correct password and a correct code, for someone with two-factor sign-in on. */
const CHALLENGE = '__Host-ol_2fa';
const CHALLENGE_MS = 10 * 60_000;
const TOKEN_TOUCH_MS = 5 * 60_000;
const EXPIRED_AUDIT_MS = 60 * 60_000;

const OPEN: Principal = { kind: 'open', id: 'local', name: 'local', role: 'admin' };

export function cookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

// Whether any user exists decides if a deployment is open (localhost) or waiting for setup. It only changes
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
  // A demo always signs visitors in (as the demo user), so it is never open.
  return isDemo() || (await anyUsers());
}

/**
 * True while a deployed workspace has no people yet: every caller would be an admin, which only
 * local development may be, so everything but the setup page is refused until its first admin
 * signs up with the setup code.
 */
export async function awaitingSetup(url: URL): Promise<boolean> {
  return !isLocalHost(url) && !(await authEnabled());
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
 * hasn't set it up; `passwordChangeDue`, one still on a password an admin set. Until they put it
 * right, they may only use their Account page.
 */
export type Caller = Principal & { twoFactorDue?: true; passwordChangeDue?: true };

/**
 * Whether someone signs in with a password, which is what two-factor sign-in protects: not when
 * they have none (people single sign-on added) or the workspace is SSO-only. Then the identity
 * provider asks for a second factor, and this app can't.
 */
async function passwordInUse(passwordHash: string | null) {
  return passwordHash !== null && !(await ssoOnlyInEffect());
}

const callers = new WeakMap<Request, Promise<Caller | null>>();

/**
 * The signed-in person for a browser request, or null. It is looked up once per Request: the
 * shell's loader and the page's run against the same one and share the answer. A client
 * navigation's `.data` fetch is a Request of its own, and so is the one React Router hands the
 * loaders after an action (a sign-in, a sign-out), so neither sees an earlier answer.
 */
export function principal(request: Request): Promise<Caller | null> {
  let found = callers.get(request);
  if (!found) {
    found = lookUpPrincipal(request);
    callers.set(request, found);
    // A failed lookup isn't kept, so asking again with the same Request tries again.
    found.catch(() => callers.delete(request));
  }
  return found;
}

async function lookUpPrincipal(request: Request): Promise<Caller | null> {
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
        passwordHash: users.passwordHash,
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
    // An admin's session goes idle sooner than the query's limit for everyone.
    if (row && now - row.seen <= sessionIdleMs(row.role as Role)) {
      const { seen, totpEnabledAt, passwordChangeDue, passwordHash, ...person } = row;
      if (now - seen > SESSION_TOUCH_MS)
        afterResponse(
          db()
            .update(sessions)
            .set({ lastSeenAt: now, ip: clientIp(request) })
            .where(eq(sessions.tokenHash, hash)),
        );
      const role = person.role as Role;
      // The shared demo visitor can't set up two-factor sign-in (its Account page is read-only).
      const due =
        person.id !== DEMO_USER.id &&
        !totpEnabledAt &&
        (await passwordInUse(passwordHash)) &&
        mustUseTwoFactor(role, await twoFactorRequirement());
      return {
        kind: 'user',
        ...person,
        role,
        ...(due ? { twoFactorDue: true as const } : {}),
        // A temporary password matters only while passwords sign people in.
        ...(passwordChangeDue && (await passwordInUse(passwordHash))
          ? { passwordChangeDue: true as const }
          : {}),
      };
    }
  }
  return null;
}

// ── Throttling failed attempts (rules in throttle.ts, counts in D1 auth_failures) ──

/** Thrown when a client must wait before trying to authenticate again. */
export class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Too many failed attempts. ${retryText(retryAfterMs)}`);
  }
}

export async function waitFor(keys: string[]) {
  const rows = await db().select().from(authFailures).where(inArray(authFailures.key, keys));
  return blockedFor(rows, Date.now());
}

/**
 * How long a password sign-in must wait (`signInKeys`). Failures for the account from many places
 * (its `email` key) don't hold back a place that has signed this person in before (one of their
 * sessions was last seen there), so someone who knows only an address can't lock its owner out;
 * that place's own limits (`email-ip`, `ip`) still apply.
 */
async function signInWait(email: string, ip: string): Promise<number> {
  const keys = signInKeys(email, ip);
  const rows = (
    await db().select().from(authFailures).where(inArray(authFailures.key, keys))
  ).filter((r) => keys.includes(r.key));
  const now = Date.now();
  const wait = blockedFor(rows, now);
  if (!wait) return 0;
  const placeKeys = keys.slice(0, 2);
  const here = blockedFor(
    rows.filter((r) => placeKeys.includes(r.key)),
    now,
  );
  if (here) return here;
  const known = await db()
    .select({ id: sessions.tokenHash })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(users.email, normalizeEmail(email)), eq(sessions.ip, ip), gt(sessions.expiresAt, now)),
    )
    .get();
  return known ? 0 : wait;
}

/** Counts a failure against each key, starting a fresh window where the old one has ended. */
export async function recordFailure(keys: string[]) {
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
 * Re-checks a signed-in person's current password (changing it, turning off two-factor sign-in,
 * new recovery codes). Wrong answers are throttled per person, so a left-open browser can't be
 * used to guess it. Throws `Throttled` while blocked; false for a wrong password.
 */
export async function reauthenticate(userId: string, given: string, hash: string) {
  const key = [throttleKey('reauth', userId)];
  const wait = await waitFor(key);
  if (wait) throw new Throttled(wait);
  if (await verifyPassword(given, hash)) return true;
  await recordFailure(key);
  return false;
}

/**
 * The caller of a REST request: a bearer token, else the browser session. Tokens are random
 * 192-bit `ol_live_` values, so guesses aren't throttled, and a busy address can't lock out
 * working integrations.
 */
export async function apiPrincipal(request: Request): Promise<Caller | null> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!bearer) return principal(request);
  if (!bearer.startsWith(API_TOKEN_PREFIX)) return null;
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
    afterResponse(db().update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)));
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
 * or (for open local dev) sign-in has been turned on. The role is
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
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(and(eq(users.id, g.id), isNull(users.disabledAt)))
      .get();
    if (!row) return null;
    const { totpEnabledAt, passwordChangeDue, passwordHash, ...person } = row;
    const own = person.role as Role;
    const due =
      !totpEnabledAt &&
      (await passwordInUse(passwordHash)) &&
      mustUseTwoFactor(own, await twoFactorRequirement());
    return {
      kind: 'user',
      ...person,
      role: lower(g.role, own),
      ...(due ? { twoFactorDue: true as const } : {}),
      ...(passwordChangeDue && (await passwordInUse(passwordHash))
        ? { passwordChangeDue: true as const }
        : {}),
    };
  }
  if (g.kind === 'open') return (await authEnabled()) ? null : { ...OPEN, role: g.role };
  return null;
}

/** Thrown for a known API token past its expiry, so the caller hears why it stopped working. */
export class TokenExpired extends Error {
  constructor(readonly expiredAt: number) {
    super(
      `This API token expired on ${new Date(expiredAt).toISOString().slice(0, 10)}. An admin can create a new one on the Team page.`,
    );
  }
}

export const forbidden = (min: Role) =>
  `This needs the ${ROLE_LABELS[min]} role. Ask an admin to change your role on the Team page.`;

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
 * Checks an email and password. Null for a wrong one, or no email.
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
  const wait = await signInWait(email, clientIp(request));
  if (wait) {
    await audit(request, 'auth.sign_in_throttled', { target });
    throw new Throttled(wait);
  }
  const r = await checkCredentials(email, given);
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
  return { cookie: await startSession(request, r.principal.id), twoFactor: false };
}

/**
 * `signIn` for someone single sign-on has already identified, whose account has a password: the
 * identity provider vouched for their email, but before that links the account (`sso.server.ts`)
 * they give its password, then their code if they use two-factor sign-in. The same throttles
 * apply. SSO-only doesn't refuse it: the password here adds to the provider's word, never
 * replaces it. Without two-factor sign-in, the session waits on `signIn`, so the caller links
 * first and signs in only once that worked.
 */
export async function signInToLink(
  request: Request,
  user: {
    id: string;
    email: string;
    passwordHash: string;
    totpEnabledAt: number | null;
    passwordChangeDue: boolean;
    passwordExpiresAt: number | null;
  },
  given: string,
): Promise<
  { twoFactor: true; cookie: string } | { twoFactor: false; signIn: () => Promise<string> } | null
> {
  const keys = signInKeys(user.email, clientIp(request));
  const wait = await signInWait(user.email, clientIp(request));
  if (wait) {
    await audit(request, 'auth.sign_in_throttled', { target: user.email });
    throw new Throttled(wait);
  }
  if (!(await verifyPassword(given, user.passwordHash))) {
    await recordFailure(keys);
    await audit(request, 'auth.sign_in_failed', {
      target: user.email,
      detail: { reason: 'wrong password', method: 'sso' },
    });
    return null;
  }
  // A temporary password that ran out links nothing, as it signs no one in.
  if (temporaryPasswordExpired(user)) {
    await recordFailure(keys);
    await audit(request, 'auth.sign_in_failed', {
      target: user.email,
      detail: { reason: 'temporary password expired', method: 'sso' },
    });
    return null;
  }
  await db().delete(authFailures).where(eq(authFailures.key, keys[0]!));
  if (user.totpEnabledAt) return { cookie: await startChallenge(user.id), twoFactor: true };
  return {
    twoFactor: false,
    signIn: async () => {
      const row = await db()
        .select({ email: users.email, name: users.name, role: users.role })
        .from(users)
        .where(eq(users.id, user.id))
        .get();
      if (row)
        await audit(request, 'auth.sign_in', {
          actor: { kind: 'user', id: user.id, ...row, role: row.role as Role },
          detail: { method: 'sso-link' },
        });
      return startSession(request, user.id);
    },
  };
}

/**
 * Whether the person is on a temporary password that has run out. Only while one is due: a
 * password they chose never expires, even if an older Worker left the column set.
 */
const temporaryPasswordExpired = (u: {
  passwordChangeDue: boolean;
  passwordExpiresAt: number | null;
}) => u.passwordChangeDue && u.passwordExpiresAt !== null && u.passwordExpiresAt <= Date.now();

async function checkCredentials(
  email: string,
  given: string,
): Promise<{ principal: Principal; twoFactor: boolean } | { reason: string }> {
  if (!email.trim()) return { reason: 'no email' };
  const user = await db()
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .get();
  decoy ??= hashPassword(randomToken());
  const ok = await verifyPassword(given, user?.passwordHash ?? (await decoy));
  if (!user) return { reason: 'unknown email' };
  if (!user.passwordHash) return { reason: 'no password set' };
  if (await ssoOnlyInEffect()) return { reason: 'SSO only' };
  if (!ok) return { reason: 'wrong password' };
  if (user.disabledAt) return { reason: 'disabled' };
  if (temporaryPasswordExpired(user)) return { reason: 'temporary password expired' };
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

/**
 * Signs a visitor in as the demo user, creating it on first use. Only in demo mode; throws
 * otherwise, so the button can't be replayed against a real workspace.
 */
export async function signInDemo(request: Request): Promise<string> {
  if (!isDemo()) throw new Error('Not a demo deployment');
  await db()
    .insert(users)
    .values({ ...DEMO_USER, createdAt: Date.now() })
    .onConflictDoNothing();
  forgetUserCount();
  await audit(request, 'auth.sign_in', {
    actor: { kind: 'user', ...DEMO_USER },
    detail: { demo: true },
  });
  return startSession(request, DEMO_USER.id);
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

/** How recent signing in again at the identity provider must be to count as a step-up. */
const SSO_STEP_UP_MS = 10 * 60_000;

/**
 * What a step-up asks this person for: a two-factor code, their password, or (single sign-on
 * only) to sign in again at the identity provider.
 */
export type StepUpMethod = 'code' | 'password' | 'sso';

async function stepUpUser(by: Principal) {
  if (by.kind !== 'user') return null;
  const user = await db().select().from(users).where(eq(users.id, by.id)).get();
  if (!user) return null;
  const method: StepUpMethod =
    user.totpEnabledAt && user.totpSecret
      ? 'code'
      : (await passwordInUse(user.passwordHash))
        ? 'password'
        : 'sso';
  return { user, method };
}

export async function stepUpMethod(by: Principal): Promise<StepUpMethod | null> {
  return (await stepUpUser(by))?.method ?? null;
}

/**
 * A step-up before a sensitive admin action (installing a plugin, rolling one back, removing it):
 * a fresh two-factor code from someone who has two-factor sign-in, else their password, else (a
 * single sign-on account with neither) signing in again at the identity provider on this session
 * within the last ten minutes (`recordReauth`). Wrong answers are throttled per person. Returns
 * null when it passes, or what to tell them.
 */
export async function stepUp(
  request: Request,
  by: Principal,
  given: { code?: string; password?: string },
): Promise<string | null> {
  if (by.kind !== 'user') return 'This needs a person signed in, not a token.';
  const key = [throttleKey('step-up', by.id)];
  const wait = await waitFor(key);
  if (wait) return `Too many tries: ${retryText(wait)}`;
  const found = await stepUpUser(by);
  if (!found) return 'Sign in again.';
  const { user, method } = found;
  if (method === 'code') {
    if (given.code && looksLikeTotp(given.code) && (await useTotp(user, given.code))) return null;
    await recordFailure(key);
    return 'Enter a current code from your authenticator app.';
  }
  if (method === 'password') {
    try {
      if (
        given.password &&
        user.passwordHash &&
        (await reauthenticate(user.id, given.password, user.passwordHash))
      )
        return null;
    } catch (err) {
      if (err instanceof Throttled) return err.message;
      throw err;
    }
    await recordFailure(key);
    return 'Your password is not right.';
  }
  const sid = await sessionId(request);
  const session = sid
    ? await db().select().from(sessions).where(eq(sessions.tokenHash, sid)).get()
    : undefined;
  if (session?.reauthAt && Date.now() - session.reauthAt < SSO_STEP_UP_MS) return null;
  return 'Confirm with single sign-on, then try within ten minutes.';
}

/**
 * Records on this session that its person just signed in again at the identity provider (a
 * step-up's `reauth` flow), when the identity is the one linked to them. Returns whether it did.
 */
export async function recordReauth(
  request: Request,
  by: Principal,
  sub: string,
  at: number,
): Promise<boolean> {
  if (by.kind !== 'user') return false;
  const sid = await sessionId(request);
  if (!sid) return false;
  const user = await db()
    .select({ externalSub: users.externalSub })
    .from(users)
    .where(eq(users.id, by.id))
    .get();
  if (!user?.externalSub || user.externalSub !== sub) return false;
  await db()
    .update(sessions)
    .set({ reauthAt: at })
    .where(and(eq(sessions.tokenHash, sid), eq(sessions.userId, by.id)));
  return true;
}

/** Accepts a code once: the step it matched must be later than the last one used. */
async function useTotp(
  user: { id: string; totpSecret: string | null; totpLastStep: number | null },
  code: string,
) {
  if (!user.totpSecret) return false;
  const secret = await openSecret(user.totpSecret, secretContext.totp(user.id));
  const step = await verifyTotp(secret, code, Date.now(), user.totpLastStep);
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

/** Ends the session server-side and returns the cookies that clear it. */
export async function signOut(request: Request): Promise<string[]> {
  const who = await principal(request);
  if (who && who.kind !== 'open') await audit(request, 'auth.sign_out', { actor: who });
  const token = cookie(request, SESSION);
  if (token)
    await db()
      .delete(sessions)
      .where(eq(sessions.tokenHash, await sha256Hex(token)));
  return [`${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, clearChallengeCookie];
}

/** Who acted, for audit fields such as an approval's `by`. */
export const actor = (p: Principal) => p.email ?? p.name;
