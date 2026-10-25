/**
 * The Team page's operations: people and API tokens. Every secret is generated here, returned
 * once to show the operator, and stored only as a hash.
 */

import { atLeast, isRole, newId, type Principal, type Role, sessionIdleMs } from '@orderloop/core';
import { apiTokens, sessions, startsWith, users } from '@orderloop/db';
import { and, count, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { endAccess, endedDetail } from './access.server';
import { audit } from './audit.server';
import { actor, forgetUserCount, reauthenticate } from './auth.server';
import {
  generatePassword,
  hashPassword,
  isEmail,
  newApiToken,
  normalizeEmail,
  passwordProblem,
} from './credentials';
import { db } from './env.server';
import { describeAgent, sessionRef } from './sessions';
import { expiresAtFor, isTokenLifetime } from './tokens';

export class TeamError extends Error {}

/** How long a temporary password (a new person's, or a reset) works before it must be used. */
export const TEMPORARY_PASSWORD_MS = 7 * 86_400_000;

export async function listTeam() {
  const [people, tokens] = await Promise.all([
    db()
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        disabledAt: users.disabledAt,
        twoFactorAt: users.totpEnabledAt,
        passwordChangeDue: users.passwordChangeDue,
      })
      .from(users)
      .orderBy(users.email),
    db()
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        prefix: apiTokens.prefix,
        role: apiTokens.role,
        createdBy: apiTokens.createdBy,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
        revokedAt: apiTokens.revokedAt,
        expiresAt: apiTokens.expiresAt,
      })
      .from(apiTokens)
      .orderBy(desc(apiTokens.createdAt)),
  ]);
  return { people, tokens };
}

function role(v: unknown): Role {
  if (!isRole(v)) throw new TeamError('Pick a role: viewer, approver, operator or admin.');
  return v;
}

/** The last active admin is the only way in to manage the team, so they can't be demoted or disabled. */
async function keepAnAdmin(exceptId: string) {
  const other = await db()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, exceptId)))
    .get();
  if (!other)
    throw new TeamError(
      'That would leave no admin to manage the team. Make someone else an admin first.',
    );
}

export type NewAdmin = { email: string; name: string; password: string };

/**
 * The first account on an open local deployment (no users): the person setting it up, as an
 * admin with a password they choose. Adding it turns sign-in on. A deployed workspace gets its
 * first admin from its setup code instead (`setup.server.ts`).
 */
export async function createFirstAdmin(request: Request, input: NewAdmin) {
  const any = await db().select({ id: users.id }).from(users).get();
  if (any) throw new TeamError('The team already has people; sign in instead.');
  return insertAdmin(request, input, 'team.first_admin');
}

/** Adds an admin with the password they chose, and records how they came in. */
export async function insertAdmin(
  request: Request,
  input: NewAdmin,
  action: 'team.first_admin' | 'team.recovery_admin',
) {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new TeamError('Enter a valid email address.');
  const problem = passwordProblem(input.password, email);
  if (problem) throw new TeamError(problem);
  const taken = await db().select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (taken)
    throw new TeamError(`${email} is already on the team; sign in, or use another address.`);
  const id = newId('usr');
  const name = input.name.trim() || email.split('@')[0]!;
  await db()
    .insert(users)
    .values({
      id,
      email,
      name,
      role: 'admin',
      passwordHash: await hashPassword(input.password),
      createdAt: Date.now(),
    });
  forgetUserCount();
  await audit(request, action, {
    actor: { kind: 'user', id, email, name, role: 'admin' },
    target: email,
  });
  return id;
}

/** Adds a person and returns the one-time password to hand them. */
export async function addUser(
  request: Request,
  by: Principal,
  input: { email: string; name: string; role: unknown },
) {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new TeamError('Enter a valid email address.');
  const exists = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (exists) throw new TeamError(`${email} is already on the team.`);
  const password = generatePassword();
  const r = role(input.role);
  await db()
    .insert(users)
    .values({
      id: newId('usr'),
      email,
      name: input.name.trim() || email.split('@')[0]!,
      role: r,
      passwordHash: await hashPassword(password),
      passwordChangeDue: true,
      passwordExpiresAt: Date.now() + TEMPORARY_PASSWORD_MS,
      createdAt: Date.now(),
    });
  forgetUserCount();
  await audit(request, 'team.user_added', { actor: by, target: email, detail: { role: r } });
  return { email, password };
}

export async function setRole(request: Request, by: Principal, id: string, next: unknown) {
  const r = role(next);
  if (r !== 'admin') await keepAnAdmin(id);
  if (id === by.id && r !== 'admin')
    throw new TeamError('Ask another admin to change your own role.');
  const user = await target(id);
  if (user.role === r) return;
  await db().update(users).set({ role: r }).where(eq(users.id, id));
  // Connected apps follow the role on their own (`grantPrincipal`); tokens carry theirs.
  const ended = atLeast(r, user.role as Role)
    ? null
    : await endAccess(request, { id, email: user.email }, { tokens: { above: r } });
  await audit(request, 'team.role_changed', {
    actor: by,
    target: user.email,
    detail: { from: user.role, to: r, ...(ended ? endedDetail(ended) : {}) },
  });
}

/** A person's role now, or null when they aren't on the team. */
async function roleOf(id: string): Promise<Role | null> {
  const row = await db().select({ role: users.role }).from(users).where(eq(users.id, id)).get();
  return row && isRole(row.role) ? row.role : null;
}

async function target(id: string) {
  const user = await db()
    .select({ email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .get();
  if (!user) throw new TeamError('That person is no longer on the team.');
  return user;
}

/**
 * Sets a new one-time password and ends what the old one could have reached: sessions, connected
 * apps and passkeys (adding one needs only the password).
 */
export async function resetPassword(request: Request, by: Principal, id: string) {
  const user = await target(id);
  const password = generatePassword();
  await db()
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      passwordChangeDue: true,
      passwordExpiresAt: Date.now() + TEMPORARY_PASSWORD_MS,
    })
    .where(eq(users.id, id));
  const ended = await endAccess(
    request,
    { id, email: user.email },
    { sessions: true, apps: true, passkeys: true },
  );
  await audit(request, 'team.password_reset', {
    actor: by,
    target: user.email,
    detail: endedDetail(ended),
  });
  return { email: user.email, password };
}

export async function setDisabled(request: Request, by: Principal, id: string, disabled: boolean) {
  if (id === by.id) throw new TeamError('You can’t disable yourself.');
  if (disabled) await keepAnAdmin(id);
  const user = await target(id);
  await db()
    .update(users)
    .set({ disabledAt: disabled ? Date.now() : null })
    .where(eq(users.id, id));
  // Enabling again brings back none of it: they sign in afresh, and apps and tokens are made anew.
  const ended = disabled
    ? await endAccess(
        request,
        { id, email: user.email },
        { sessions: true, apps: true, tokens: true },
      )
    : null;
  await audit(request, disabled ? 'team.user_disabled' : 'team.user_enabled', {
    actor: by,
    target: user.email,
    ...(ended ? { detail: endedDetail(ended) } : {}),
  });
}

/** Creates an API token and returns it once. */
export async function createToken(
  request: Request,
  by: Principal,
  input: { name: string; role: unknown; lifetime: unknown },
) {
  const name = input.name.trim();
  if (!isTokenLifetime(input.lifetime)) throw new TeamError('Pick how long the token lasts.');
  const expiresAt = expiresAtFor(input.lifetime, Date.now());
  if (!name) throw new TeamError('Name the token after what will use it, e.g. “ERP sync”.');
  const t = await newApiToken();
  const r = role(input.role);
  const id = newId('tok');
  await db()
    .insert(apiTokens)
    .values({
      id,
      name,
      prefix: t.prefix,
      tokenHash: t.hash,
      role: r,
      createdBy: actor(by),
      createdById: by.kind === 'user' ? by.id : null,
      createdAt: Date.now(),
      expiresAt,
    });
  // A disable or demotion that landed while this request was on its way ran before this row
  // existed: check again now that it does (making tokens is an admin's), and take it back if not.
  const maker =
    by.kind === 'user'
      ? await db()
          .select({ role: users.role, disabledAt: users.disabledAt })
          .from(users)
          .where(eq(users.id, by.id))
          .get()
      : undefined;
  if (by.kind === 'user' && (!maker || maker.disabledAt || maker.role !== 'admin')) {
    await db().update(apiTokens).set({ revokedAt: Date.now() }).where(eq(apiTokens.id, id));
    throw new TeamError('Your access changed while the token was being made; it was not created.');
  }
  await audit(request, 'token.created', {
    actor: by,
    target: name,
    detail: { role: r, prefix: t.prefix, expiresAt },
  });
  return { name, token: t.token, expiresAt };
}

export async function revokeToken(request: Request, by: Principal, id: string) {
  const token = await db()
    .select({ name: apiTokens.name, prefix: apiTokens.prefix, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .get();
  if (!token || token.revokedAt) return;
  await db().update(apiTokens).set({ revokedAt: Date.now() }).where(eq(apiTokens.id, id));
  await audit(request, 'token.revoked', {
    actor: by,
    target: token.name,
    detail: { prefix: token.prefix },
  });
}

/** A signed-in person changes their own password: how many connected apps that disconnected. */
export async function changeOwnPassword(
  request: Request,
  by: Principal,
  current: string,
  next: string,
) {
  if (by.kind !== 'user')
    throw new TeamError('Only people with their own sign-in have a password.');
  const user = await db().select().from(users).where(eq(users.id, by.id)).get();
  if (!user?.passwordHash || !(await reauthenticate(user.id, current, user.passwordHash)))
    throw new TeamError('Your current password is not right.');
  const problem = passwordProblem(next, user.email);
  if (problem) throw new TeamError(problem);
  await db()
    .update(users)
    .set({
      passwordHash: await hashPassword(next),
      passwordChangeDue: false,
      passwordExpiresAt: null,
    })
    .where(eq(users.id, by.id));
  // In case the old password leaked: apps connected with it go (the route ends other sessions).
  const ended = await endAccess(request, user, { apps: true });
  await audit(request, 'auth.password_changed', {
    actor: by,
    target: user.email,
    ...(ended.apps ? { detail: { apps: ended.apps } } : {}),
  });
  return ended.apps;
}

/** The signed-in person's live sessions, newest activity first; `current` marks this browser. */
export async function ownSessions(by: Principal, currentHash: string | undefined) {
  if (by.kind !== 'user') return [];
  const now = Date.now();
  const rows = await db()
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, by.id), gt(sessions.expiresAt, now)))
    .all();
  return rows
    .map((r) => ({
      ref: sessionRef(r.tokenHash),
      current: r.tokenHash === currentHash,
      device: describeAgent(r.userAgent),
      ip: r.ip,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt ?? r.createdAt,
    }))
    .filter((r) => now - r.lastSeenAt < sessionIdleMs(by.role))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
}

/** Signs out one of the person's own sessions, by its reference; never the current one. */
export async function endOwnSession(
  request: Request,
  by: Principal,
  ref: string,
  currentHash: string | undefined,
) {
  if (by.kind !== 'user' || !/^[0-9a-f]{16}$/.test(ref))
    throw new TeamError('That session is no longer active.');
  if (currentHash && sessionRef(currentHash) === ref)
    throw new TeamError('Use Sign out to end this session.');
  const row = await db()
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, by.id), startsWith(sessions.tokenHash, ref)))
    .get();
  if (!row) throw new TeamError('That session is no longer active.');
  await db().delete(sessions).where(eq(sessions.tokenHash, row.tokenHash));
  await audit(request, 'auth.session_ended', {
    actor: by,
    target: by.email,
    detail: { device: describeAgent(row.userAgent), ip: row.ip },
  });
}

/** Signs out every session of the person's except this one. */
export async function endOtherSessions(
  request: Request,
  by: Principal,
  currentHash: string | undefined,
) {
  if (by.kind !== 'user') return 0;
  const others = and(
    eq(sessions.userId, by.id),
    currentHash ? ne(sessions.tokenHash, currentHash) : undefined,
  );
  const n = (await db().select({ n: count() }).from(sessions).where(others).get())?.n ?? 0;
  await db().delete(sessions).where(others);
  if (n)
    await audit(request, 'auth.other_sessions_ended', {
      actor: by,
      target: by.email,
      detail: { count: n },
    });
  return n;
}

/**
 * Changes that hand out access or lower the bar for it ask who is at the keyboard first
 * (`stepUp`): making an API or SCIM token, making someone an admin (directly, or by mapping a
 * group to Admin), enabling someone above Viewer, resetting someone's password or two-factor
 * sign-in, and the single sign-on and two-factor settings. Open local dev (no one
 * signed in) has no one to ask.
 */
const STEPPED_UP = new Set([
  'add-token',
  'scim-token',
  'reset',
  'reset-two-factor',
  'sso-settings',
  'two-factor-requirement',
]);

export async function needsStepUp(intent: string, f: FormData): Promise<boolean> {
  if (STEPPED_UP.has(intent)) return true;
  // A group mapped to Admin makes each of its members one at once.
  if (intent === 'scim-roles')
    return [...f.entries()].some(([k, v]) => k.startsWith('role:') && v === 'admin');
  // Enabling someone above Viewer gives back what their old password could do.
  if (intent === 'enable') {
    const role = await roleOf(String(f.get('id') ?? ''));
    return role !== null && role !== 'viewer';
  }
  if (f.get('role') !== 'admin') return false;
  if (intent === 'add-user') return true;
  return intent === 'role' && (await roleOf(String(f.get('id') ?? ''))) !== 'admin';
}
