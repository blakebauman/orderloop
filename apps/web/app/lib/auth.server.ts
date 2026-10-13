/**
 * Who is signed in, and what they may do. Roles are in `@orderloop/core` (viewer < approver <
 * operator).
 *
 * - People sign in with an email and password from D1 `users`; the `__Host-ol_session` cookie holds
 *   a random token whose SHA-256 is a `sessions` row.
 * - The REST API takes `Authorization: Bearer ol_live_…`, an `api_tokens` row with its own role.
 * - `APP_PASSWORD`, when set, is a break-glass operator: sign in with the password and no email
 *   (the older HMAC cookie), or send it as the bearer token.
 * - With no `APP_PASSWORD` and no users (local development) everything is open, as an operator.
 *
 * Users carry an `external_sub` column for linking an outside identity later; sign-in through
 * an outside provider would create the same session row.
 */

import { env } from 'cloudflare:workers';
import { atLeast, type Principal, ROLE_LABELS, type Role } from '@orderloop/core';
import { apiTokens, sessions, users } from '@orderloop/db';
import { and, count, eq, gt, isNull } from 'drizzle-orm';
import { data, redirect } from 'react-router';
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

const SESSION = '__Host-ol_session';
/** The shared-password cookie: an HMAC of APP_PASSWORD. */
const SHARED = 'ol_session';
const SESSION_DAYS = 30;
const TOKEN_TOUCH_MS = 5 * 60_000;

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

/** The signed-in person (or shared-password operator) for a browser request, or null. */
export async function principal(request: Request): Promise<Principal | null> {
  if (!(await authEnabled())) return OPEN;
  const token = cookie(request, SESSION);
  if (token) {
    const row = await db()
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, await sha256Hex(token)),
          gt(sessions.expiresAt, Date.now()),
          isNull(users.disabledAt),
        ),
      )
      .get();
    if (row) return { kind: 'user', ...row, role: row.role as Role };
  }
  const pw = password();
  const shared = cookie(request, SHARED);
  if (pw && shared && safeEqual(shared, await hmac(pw))) return SHARED_PRINCIPAL;
  return null;
}

/** The caller of a REST request: a bearer token, else the browser session. */
export async function apiPrincipal(request: Request): Promise<Principal | null> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!bearer) return principal(request);
  const pw = password();
  if (pw && safeEqual(bearer, pw)) return SHARED_PRINCIPAL;
  if (!bearer.startsWith(API_TOKEN_PREFIX)) return null;
  const row = await db()
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, await sha256Hex(bearer)), isNull(apiTokens.revokedAt)))
    .get();
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt > TOKEN_TOUCH_MS)
    await db().update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, row.id));
  return { kind: 'token', id: row.id, name: `token:${row.name}`, role: row.role as Role };
}

export const forbidden = (min: Role) =>
  `This needs the ${ROLE_LABELS[min]} role. Ask an operator to change your role on the Team page.`;

/**
 * Loader/action guard. Not signed in: redirect to sign-in. Signed in without `min`: 403. Returns
 * the principal for audit fields and for hiding what the role can't use.
 */
export async function requireUser(request: Request, min: Role = 'viewer'): Promise<Principal> {
  const p = await principal(request);
  if (!p) {
    const url = new URL(request.url);
    throw redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  if (!atLeast(p.role, min)) throw data({ ok: false, error: forbidden(min) }, { status: 403 });
  return p;
}

const sessionCookie = (token: string) =>
  `${SESSION}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;

// Compared against when the email is unknown, so a miss costs the same PBKDF2 work as a hit.
let decoy: Promise<string> | null = null;

/** Signs in and returns the cookie to set, or null. No email means the shared APP_PASSWORD. */
export async function signIn(email: string, given: string): Promise<string | null> {
  if (!email.trim()) {
    const pw = password();
    if (!pw || !safeEqual(given, pw)) return null;
    return `${SHARED}=${await hmac(pw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
  }
  const user = await db()
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .get();
  decoy ??= hashPassword(randomToken());
  const ok = await verifyPassword(given, user?.passwordHash ?? (await decoy));
  if (!user || !ok || user.disabledAt || !user.passwordHash) return null;
  return startSession(user.id);
}

/** Creates a session for a user and returns the cookie to set. */
export async function startSession(userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db()
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(token),
      userId,
      createdAt: now,
      expiresAt: now + SESSION_DAYS * 86_400_000,
    });
  await db().update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return sessionCookie(token);
}

/** Ends the session server-side and returns cookies that clear both kinds. */
export async function signOut(request: Request): Promise<string[]> {
  const token = cookie(request, SESSION);
  if (token)
    await db()
      .delete(sessions)
      .where(eq(sessions.tokenHash, await sha256Hex(token)));
  return [
    `${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${SHARED}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ];
}

/** Who acted, for audit fields such as an approval's `by`. */
export const actor = (p: Principal) => p.email ?? p.name;
