/**
 * Who is calling an agent over a proxied socket, as they are now. The web app sets the principal
 * header when it proxies a socket (PRINCIPAL_HEADER); agents keep it on the connection and re-read
 * it here before acting, so signing out, a password reset, being disabled or a role change applies
 * to a page that is already open.
 */

import {
  isRole,
  type Principal,
  type ProxiedPrincipal,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
} from '@orderloop/core';
import { createDb, sessions, users } from '@orderloop/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

/**
 * A person's principal from their live session: null once it has expired or been deleted, or the
 * user is disabled; otherwise with their current role, name and email. The shared password and
 * open local dev have no session to check. Using a socket counts as activity, so it keeps the
 * session from going idle.
 */
export async function livePrincipal(env: Env, p: ProxiedPrincipal): Promise<Principal | null> {
  const { session, ...principal } = p;
  if (p.kind !== 'user') return principal;
  if (!session) return null;
  const db = createDb(env.DB);
  const now = Date.now();
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
  if (now - row.seen > SESSION_TOUCH_MS)
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.tokenHash, session));
  const { seen: _seen, ...person } = row;
  return { kind: 'user', ...person, role: row.role };
}

export const SESSION_ENDED = 'Your sign-in has ended. Reload the page to sign in again.';
