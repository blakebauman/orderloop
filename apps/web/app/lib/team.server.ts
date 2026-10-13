/**
 * The Team page's operations: people and API tokens. Every secret is generated here, returned
 * once to show the operator, and stored only as a hash.
 */

import { env } from 'cloudflare:workers';
import { isRole, newId, type Principal, type Role } from '@orderloop/core';
import { apiTokens, sessions, users } from '@orderloop/db';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { actor, forgetUserCount } from './auth.server';
import {
  generatePassword,
  hashPassword,
  isEmail,
  newApiToken,
  normalizeEmail,
  passwordProblem,
  verifyPassword,
} from './credentials';
import { db } from './env.server';

export class TeamError extends Error {}

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
      })
      .from(apiTokens)
      .orderBy(desc(apiTokens.createdAt)),
  ]);
  return { people, tokens };
}

function role(v: unknown): Role {
  if (!isRole(v)) throw new TeamError('Pick a role: viewer, approver or operator.');
  return v;
}

/**
 * Without APP_PASSWORD, the last active operator is the only way in to manage the team, so they
 * can't be demoted or disabled.
 */
async function keepAnOperator(exceptId: string) {
  if ((env as { APP_PASSWORD?: string }).APP_PASSWORD) return;
  const other = await db()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'operator'), isNull(users.disabledAt), ne(users.id, exceptId)))
    .get();
  if (!other)
    throw new TeamError(
      'That would leave no operator to manage the team. Make someone else an operator first.',
    );
}

/**
 * The first account on an open deployment (no APP_PASSWORD, no users): the person setting it up,
 * as an operator with a password they choose. Adding it turns sign-in on.
 */
export async function createFirstOperator(input: {
  email: string;
  name: string;
  password: string;
}) {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new TeamError('Enter a valid email address.');
  const problem = passwordProblem(input.password, email);
  if (problem) throw new TeamError(problem);
  const any = await db().select({ id: users.id }).from(users).get();
  if (any) throw new TeamError('The team already has people; sign in instead.');
  const id = newId('usr');
  await db()
    .insert(users)
    .values({
      id,
      email,
      name: input.name.trim() || email.split('@')[0]!,
      role: 'operator',
      passwordHash: await hashPassword(input.password),
      createdAt: Date.now(),
    });
  forgetUserCount();
  return id;
}

/** Adds a person and returns the one-time password to hand them. */
export async function addUser(input: { email: string; name: string; role: unknown }) {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new TeamError('Enter a valid email address.');
  const exists = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (exists) throw new TeamError(`${email} is already on the team.`);
  const password = generatePassword();
  await db()
    .insert(users)
    .values({
      id: newId('usr'),
      email,
      name: input.name.trim() || email.split('@')[0]!,
      role: role(input.role),
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
    });
  forgetUserCount();
  return { email, password };
}

export async function setRole(by: Principal, id: string, next: unknown) {
  const r = role(next);
  if (r !== 'operator') await keepAnOperator(id);
  if (id === by.id && r !== 'operator')
    throw new TeamError('Ask another operator to change your own role.');
  await db().update(users).set({ role: r }).where(eq(users.id, id));
}

/** Sets a new one-time password and signs the person out everywhere. */
export async function resetPassword(id: string) {
  const user = await db().select({ email: users.email }).from(users).where(eq(users.id, id)).get();
  if (!user) throw new TeamError('That person is no longer on the team.');
  const password = generatePassword();
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, id));
  await db().delete(sessions).where(eq(sessions.userId, id));
  return { email: user.email, password };
}

export async function setDisabled(by: Principal, id: string, disabled: boolean) {
  if (id === by.id) throw new TeamError('You can’t disable yourself.');
  if (disabled) await keepAnOperator(id);
  await db()
    .update(users)
    .set({ disabledAt: disabled ? Date.now() : null })
    .where(eq(users.id, id));
  if (disabled) await db().delete(sessions).where(eq(sessions.userId, id));
}

/** Creates an API token and returns it once. */
export async function createToken(by: Principal, input: { name: string; role: unknown }) {
  const name = input.name.trim();
  if (!name) throw new TeamError('Name the token after what will use it, e.g. “ERP sync”.');
  const t = await newApiToken();
  await db()
    .insert(apiTokens)
    .values({
      id: newId('tok'),
      name,
      prefix: t.prefix,
      tokenHash: t.hash,
      role: role(input.role),
      createdBy: actor(by),
      createdAt: Date.now(),
    });
  return { name, token: t.token };
}

export async function revokeToken(id: string) {
  await db().update(apiTokens).set({ revokedAt: Date.now() }).where(eq(apiTokens.id, id));
}

/** A signed-in person changes their own password. */
export async function changeOwnPassword(by: Principal, current: string, next: string) {
  if (by.kind !== 'user')
    throw new TeamError('Only people with their own sign-in have a password.');
  const user = await db().select().from(users).where(eq(users.id, by.id)).get();
  if (!user?.passwordHash || !(await verifyPassword(current, user.passwordHash)))
    throw new TeamError('Your current password is not right.');
  const problem = passwordProblem(next, user.email);
  if (problem) throw new TeamError(problem);
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(next) })
    .where(eq(users.id, by.id));
}
