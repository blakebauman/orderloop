/**
 * Who is calling. The web app signs the principal header (PRINCIPAL_HEADER) onto each request it
 * forwards: the order page's and the assistant's sockets, `/mcp` and `/a2a`. `forwardedPrincipal`
 * believes it only with a valid signature for that path. Agents keep a socket's principal on the
 * connection and re-read it with `livePrincipal` before acting, so signing out, a password reset,
 * being disabled, a role change, a revoked token or sign-in being turned on applies to a page that
 * is already open.
 */

import {
  type CartGuest,
  isRole,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  sessionIdleMs,
  verifyCartGuest,
  verifyPrincipal,
} from '@orderloop/core';
import { apiTokens, createDb, sessions, users } from '@orderloop/db';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';

/** The principal the web app signed onto this request, or null. */
export function forwardedPrincipal(env: Env, request: Request): Promise<ProxiedPrincipal | null> {
  if (!env.PRINCIPAL_KEY) console.error('PRINCIPAL_KEY is not set: refusing forwarded requests');
  return verifyPrincipal(
    [env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS],
    request.headers.get(PRINCIPAL_HEADER),
    new URL(request.url).pathname,
  );
}

/** The external cart's buyer the web app signed onto this request, or null (see `verifyCartGuest`). */
export function forwardedGuest(env: Env, request: Request): Promise<CartGuest | null> {
  return verifyCartGuest(
    [env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS],
    request.headers.get(PRINCIPAL_HEADER),
    new URL(request.url).pathname,
  );
}

/**
 * A principal as it is now. A person's comes from their live session: null once it has expired or
 * been deleted, or the user is disabled; otherwise with their current role, name and email. Using
 * a socket counts as activity, so it keeps the session from going idle. An API token's is null
 * once it is revoked or expired, and open local dev's once anyone has an account.
 */
export async function livePrincipal(
  env: Env,
  p: ProxiedPrincipal,
  /**
   * `touch: false` for a check the person didn't make (a socket re-check, a panel's poll): it
   * reads the session without counting as use, so a page left open still goes idle.
   */
  { touch = true }: { touch?: boolean } = {},
): Promise<Principal | null> {
  const { session, ...principal } = p;
  const db = createDb(env.DB);
  const now = Date.now();
  if (p.kind === 'open') {
    const anyone = await db.select({ id: users.id }).from(users).limit(1).get();
    return anyone ? null : principal;
  }
  if (p.kind === 'token') {
    const token = await db
      .select({ role: apiTokens.role })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.id, p.id),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
        ),
      )
      .get();
    return token && isRole(token.role) ? { ...principal, role: token.role } : null;
  }
  if (!session) return null;
  const seen = sql<number>`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`;
  const row = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, seen })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, session),
        gt(sessions.expiresAt, now),
        gt(seen, now - SESSION_IDLE_MS),
        isNull(users.disabledAt),
      ),
    )
    .get();
  if (!row || !isRole(row.role)) return null;
  // An admin's session goes idle sooner than the query's limit for everyone.
  if (now - row.seen > sessionIdleMs(row.role)) return null;
  if (touch && now - row.seen > SESSION_TOUCH_MS)
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.tokenHash, session));
  const { seen: _seen, ...person } = row;
  return { kind: 'user', ...person, role: row.role };
}

/**
 * Whether whoever is behind `<kind>:<id>` (an A2AAgent's name) may still hear about their orders
 * when no request is open: not a person who has been disabled, nor a token revoked or expired. A
 * name that matches no row isn't refused (tests, and rows are never deleted); a kind other than a
 * person, a token or open local dev is.
 */
export async function stillActive(env: Env, kind: string, id: string): Promise<boolean> {
  const db = createDb(env.DB);
  if (kind === 'user') {
    const row = await db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, id))
      .get();
    return !row?.disabledAt;
  }
  if (kind === 'token') {
    const row = await db
      .select({ revokedAt: apiTokens.revokedAt, expiresAt: apiTokens.expiresAt })
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .get();
    return !row || (!row.revokedAt && (row.expiresAt === null || row.expiresAt > Date.now()));
  }
  return kind === 'open';
}

export const SESSION_ENDED = 'Your sign-in has ended. Reload the page to sign in again.';
