/**
 * Ending what a person can still reach, in one place: their sessions, the apps they connected
 * (OAuth grants), the API tokens they made and their passkeys. Disabling someone, resetting their
 * password or two-factor sign-in, demoting them and SCIM deactivating them each end the parts that
 * no longer fit, so a credential made under the old trust doesn't outlive it.
 */

import { ROLES, type Role } from '@orderloop/core';
import { apiTokens, sessions } from '@orderloop/db';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db, engine } from './env.server';
import { oauthApi } from './oauth.server';
import { clearPasskeys } from './passkeys.server';

export type Person = { id: string; email: string };

export type EndWhat = {
  /** Every session, or every one but this session hash (the browser asking). */
  sessions?: true | { except: string };
  /** Every token they made, or only those with a role above this one. */
  tokens?: true | { above: Role };
  /** Connected apps. */
  apps?: true;
  /** Passkeys: for a password or device that may be in someone else's hands. */
  passkeys?: true;
};

export type Ended = { sessions: number; apps: number; tokens: number; passkeys: number };

/** The roles above `role`. */
const above = (role: Role) => ROLES.slice(ROLES.indexOf(role) + 1);

/**
 * Ends what `what` names for `person`, and says how many of each. Tokens are matched by their
 * maker's id, or by `created_by` (the email) for tokens made before the id was kept. Ending apps
 * also drops the A2A push configs the person registered.
 */
export async function endAccess(request: Request, person: Person, what: EndWhat): Promise<Ended> {
  const ended: Ended = { sessions: 0, apps: 0, tokens: 0, passkeys: 0 };
  if (what.sessions) {
    const except = what.sessions === true ? undefined : what.sessions.except;
    const rows = await db()
      .delete(sessions)
      .where(
        and(eq(sessions.userId, person.id), except ? ne(sessions.tokenHash, except) : undefined),
      )
      .returning({ id: sessions.tokenHash });
    ended.sessions = rows.length;
  }
  if (what.tokens) {
    const roles = what.tokens === true ? null : above(what.tokens.above);
    if (!roles || roles.length) {
      const rows = await db()
        .update(apiTokens)
        .set({ revokedAt: Date.now() })
        .where(
          and(
            or(
              eq(apiTokens.createdById, person.id),
              and(isNull(apiTokens.createdById), eq(apiTokens.createdBy, person.email)),
            ),
            isNull(apiTokens.revokedAt),
            roles ? inArray(apiTokens.role, roles) : undefined,
          ),
        )
        .returning({ id: apiTokens.id });
      ended.tokens = rows.length;
    }
  }
  if (what.apps) {
    const oauth = oauthApi(request);
    let cursor: string | undefined;
    do {
      const page = await oauth.listUserGrants(person.id, { cursor });
      for (const g of page.items) await oauth.revokeGrant(g.id, person.id);
      ended.apps += page.items.length;
      cursor = page.cursor;
    } while (cursor);
    // An A2A app's push configs outlive its grant in the engine; they go with it.
    await engine().dropA2aPushes('user', person.id);
  }
  if (what.passkeys) ended.passkeys = await clearPasskeys(person.id);
  return ended;
}

/** Only the counts that ended something, for an audit entry's detail. */
export const endedDetail = (e: Ended) =>
  Object.fromEntries(Object.entries(e).filter(([, n]) => n > 0)) as Partial<Ended>;
