import { env } from 'cloudflare:workers';
import {
  PRINCIPAL_HEADER,
  type Principal,
  SESSION_IDLE_ADMIN_MS,
  signPrincipal,
} from '@orderloop/core';
import { apiTokens, createDb, sessions, users } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { livePrincipal } from '../src/principal';
import { signed } from './principal';

const admin: Principal = { kind: 'user', id: 'usr_forged', name: 'forged', role: 'admin' };

const post = (path: string, header?: string) =>
  worker.fetch(
    new Request(`https://engine${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'a2a-version': '1.0',
        ...(header ? { [PRINCIPAL_HEADER]: header } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    env,
  );

describe('signed principal header', () => {
  it('refuses an unsigned, forged, misdirected or expired header on /mcp and /a2a', async () => {
    const unsigned = btoa(JSON.stringify(admin));
    const forged = await signPrincipal('not-the-key', admin, '/mcp');
    const expired = await signPrincipal(
      (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!,
      admin,
      '/mcp',
      Date.now() - 120_000,
    );
    for (const header of [undefined, unsigned, forged, expired])
      expect((await post('/mcp', header)).status).toBe(401);
    expect((await post('/a2a', await signed(admin, '/mcp'))).status).toBe(401);
    expect((await post('/mcp', await signed(admin, '/mcp'))).status).toBe(200);
  });
});

describe('livePrincipal', () => {
  const db = createDb(env.DB);

  it('drops an API token once it is revoked or expired, and follows its role', async () => {
    const now = Date.now();
    const row = {
      name: 'ci',
      prefix: 'ol_live_x',
      role: 'operator',
      createdBy: 'usr_admin',
      createdAt: now,
    };
    await db.insert(apiTokens).values([
      { ...row, id: 'tok_live', tokenHash: 'h1' },
      { ...row, id: 'tok_revoked', tokenHash: 'h2', revokedAt: now },
      { ...row, id: 'tok_expired', tokenHash: 'h3', expiresAt: now - 1 },
    ]);
    const token = (id: string): Principal => ({
      kind: 'token',
      id,
      name: 'token:ci',
      role: 'admin',
    });
    expect(await livePrincipal(env, token('tok_live'))).toMatchObject({ role: 'operator' });
    expect(await livePrincipal(env, token('tok_revoked'))).toBeNull();
    expect(await livePrincipal(env, token('tok_expired'))).toBeNull();
    expect(await livePrincipal(env, token('tok_missing'))).toBeNull();
  });

  it('ends open local dev once someone has an account', async () => {
    const open: Principal = { kind: 'open', id: 'open', name: 'Local', role: 'admin' };
    await db.delete(users);
    expect(await livePrincipal(env, open)).toEqual(open);
    await db.insert(users).values({
      id: 'usr_first',
      email: 'first@example.com',
      name: 'First',
      role: 'admin',
      createdAt: Date.now(),
    });
    expect(await livePrincipal(env, open)).toBeNull();
  });

  it('ends an admin’s idle session sooner than anyone else’s', async () => {
    const seen = Date.now() - SESSION_IDLE_ADMIN_MS - 60_000;
    for (const role of ['admin', 'operator'] as const) {
      const id = `usr_idle_${role}`;
      await db
        .insert(users)
        .values({ id, email: `${role}@idle.example`, name: role, role, createdAt: 0 })
        .onConflictDoNothing();
      await db
        .insert(sessions)
        .values({
          tokenHash: `sess_${id}`,
          userId: id,
          createdAt: seen,
          lastSeenAt: seen,
          expiresAt: Date.now() + 86_400_000,
        })
        .onConflictDoNothing();
    }
    const p = (role: 'admin' | 'operator') => ({
      kind: 'user' as const,
      id: `usr_idle_${role}`,
      name: role,
      role,
      session: `sess_usr_idle_${role}`,
    });
    expect(await livePrincipal(env, p('admin'))).toBeNull();
    // A check no one made (a socket re-check, a panel's poll) reads without counting as use.
    const before = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, 'sess_usr_idle_operator'))
      .get();
    expect(await livePrincipal(env, p('operator'), { touch: false })).toMatchObject({
      role: 'operator',
    });
    const after = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, 'sess_usr_idle_operator'))
      .get();
    expect(after!.lastSeenAt).toBe(before!.lastSeenAt);
    expect(await livePrincipal(env, p('operator'))).toMatchObject({ role: 'operator' });
    const touched = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, 'sess_usr_idle_operator'))
      .get();
    expect(touched!.lastSeenAt).toBeGreaterThan(before!.lastSeenAt!);
  });
});
