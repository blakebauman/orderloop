import { env } from 'cloudflare:workers';
import {
  APPROVAL_SEPARATION_KEY,
  type ProxiedPrincipal,
  STEP_UP_MS,
  STEP_UP_NEEDED,
} from '@orderloop/core';
import {
  apiTokens,
  auditEvents,
  createDb,
  sessions,
  users,
  workspaceSettings,
} from '@orderloop/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { previewAction, runAction } from '../src/assistant/data';
import { livePrincipal } from '../src/principal';

const db = () => createDb(env.DB);

/** A person with a live session, stepped up `steppedUp` ms ago (or never). */
async function admin(email: string, steppedUp?: number) {
  const id = `usr_${email.split('@')[0]}`;
  const session = `sess_${id}`;
  await db()
    .insert(users)
    .values({ id, email, name: email.split('@')[0]!, role: 'admin', createdAt: Date.now() })
    .onConflictDoUpdate({ target: users.id, set: { role: 'admin', disabledAt: null } });
  await db()
    .insert(sessions)
    .values({
      tokenHash: session,
      userId: id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      reauthAt: steppedUp === undefined ? null : Date.now() - steppedUp,
    })
    .onConflictDoUpdate({
      target: sessions.tokenHash,
      set: { reauthAt: steppedUp === undefined ? null : Date.now() - steppedUp },
    });
  const forwarded: ProxiedPrincipal = {
    kind: 'user',
    id,
    name: email.split('@')[0]!,
    email,
    role: 'admin',
    session,
  };
  // As the engine reads them: the step-up time comes from the session row, nothing else.
  const p = await livePrincipal(env, forwarded);
  if (!p) throw new Error('no session');
  return p;
}

async function person(id: string, role: string) {
  await db()
    .insert(users)
    .values({ id, email: `${id}@example.com`, name: id, role, createdAt: Date.now() })
    .onConflictDoUpdate({ target: users.id, set: { role, disabledAt: null } });
}

describe('the team through the assistant', () => {
  it('reads the step-up from the session, never from what was forwarded', async () => {
    const forged = await livePrincipal(env, {
      kind: 'user',
      id: 'usr_nobody',
      name: 'x',
      role: 'admin',
      session: 'sess_missing',
      steppedUpAt: Date.now(),
    } as ProxiedPrincipal);
    expect(forged).toBeNull();
    const fresh = await admin('stepped@example.com', 1_000);
    expect(fresh.steppedUpAt).toBeGreaterThan(Date.now() - STEP_UP_MS);
    expect((await admin('never@example.com')).steppedUpAt).toBeUndefined();
  });

  it('changes a role on its card; making an admin needs a step-up on the session', async () => {
    const ann = await admin('team-ann@example.com');
    await person('usr_team_bob', 'operator');
    await db().insert(apiTokens).values({
      id: 'tok_team_bob',
      name: 'Bob’s sync',
      prefix: 'ol_live_x',
      tokenHash: 'h_team_bob',
      role: 'operator',
      createdBy: 'usr_team_bob@example.com',
      createdById: 'usr_team_bob',
      createdAt: Date.now(),
    });

    // Lowered: the card says what ends, and their tokens above the new role are revoked.
    const down = { userId: 'usr_team_bob', role: 'viewer' as const };
    const card = await previewAction(env, ann, 'set_member_role', down);
    expect(card).toMatchObject({ title: 'Make usr_team_bob Viewer' });
    expect(card.stepUp).toBeUndefined();
    await runAction(env, ann, 'set_member_role', down, 'assistant');
    const token = await db().select().from(apiTokens).where(eq(apiTokens.id, 'tok_team_bob')).get();
    expect(token?.revokedAt).not.toBeNull();
    const logged = await db()
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'team.role_changed'),
          eq(auditEvents.target, 'usr_team_bob@example.com'),
        ),
      )
      .get();
    expect(JSON.parse(logged!.detail!)).toMatchObject({
      from: 'operator',
      to: 'viewer',
      tokens: 1,
    });

    // Made an admin: the card asks for a step-up, and without one the confirm is refused.
    const up = { userId: 'usr_team_bob', role: 'admin' as const };
    expect((await previewAction(env, ann, 'set_member_role', up)).stepUp).toBe(true);
    await expect(runAction(env, ann, 'set_member_role', up, 'assistant')).rejects.toThrow(
      STEP_UP_NEEDED,
    );
    // A step-up older than the window doesn't count; a fresh one does.
    const stale = await admin('team-ann@example.com', STEP_UP_MS + 1_000);
    await expect(runAction(env, stale, 'set_member_role', up, 'assistant')).rejects.toThrow(
      STEP_UP_NEEDED,
    );
    const fresh = await admin('team-ann@example.com', 5_000);
    await runAction(env, fresh, 'set_member_role', up, 'assistant');
    expect((await db().select().from(users).where(eq(users.id, 'usr_team_bob')).get())?.role).toBe(
      'admin',
    );

    // Your own role is another admin's to change; an API token changes no one's.
    expect(
      (await previewAction(env, ann, 'set_member_role', { userId: ann.id, role: 'viewer' }))
        .blocked,
    ).toBe('Ask another admin to change your own role.');
    expect(
      (
        await previewAction(
          env,
          { kind: 'token', id: 'tok_admin', name: 'CI', role: 'admin' },
          'set_member_role',
          down,
        )
      ).blocked,
    ).toBe('A person changes the team, signed in as themselves.');
  });

  it('never lets a connected app or MCP change the team', async () => {
    const ann = await admin('grant-ann@example.com');
    await person('usr_grant_bob', 'operator');
    const down = { userId: 'usr_grant_bob', role: 'viewer' as const };
    // A connected app acts as its person (`kind: 'user'`) but carries its grant: refused.
    const app = { ...ann, grant: 'g1', client: 'c1' };
    expect((await previewAction(env, app, 'set_member_role', down)).blocked).toBe(
      'A person changes the team, signed in as themselves.',
    );
    expect((await previewAction(env, app, 'set_approval_separation', { on: false })).blocked).toBe(
      'A person changes the team, signed in as themselves.',
    );
    // Nor over MCP or A2A at all, even as the person.
    await expect(runAction(env, ann, 'set_member_role', down, 'MCP')).rejects.toThrow(
      'This is changed only in the app, by a person signed in.',
    );
    await expect(
      runAction(env, ann, 'set_approval_separation', { on: true }, 'A2A'),
    ).rejects.toThrow('This is changed only in the app, by a person signed in.');
  });

  it('sets approval separation on its card, and says when it is already so', async () => {
    const ann = await admin('sep-ann@example.com');
    await db().delete(workspaceSettings).where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY));
    expect((await previewAction(env, ann, 'set_approval_separation', { on: false })).blocked).toBe(
      'It is already set that way.',
    );
    await runAction(env, ann, 'set_approval_separation', { on: true }, 'assistant');
    const row = await db()
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY))
      .get();
    expect(row).toMatchObject({ value: 'on', updatedBy: 'sep-ann@example.com' });
    await db().delete(workspaceSettings).where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY));
  });

  it('asks a step-up for the plugin changes the Plugins page did', async () => {
    const { stepUpNeeded } = await import('../src/assistant/admin');
    const ann = await admin('plug-ann@example.com');
    const token = { kind: 'token' as const, id: 'tok_ops', name: 'Ops', role: 'admin' as const };
    for (const tool of ['approve_plugin', 'rollback_plugin', 'uninstall_plugin'])
      expect(await stepUpNeeded(env, ann, tool, { pluginId: 'x' })).toBe(true);
    expect(await stepUpNeeded(env, ann, 'set_plugin_enabled', { enabled: true })).toBe(true);
    // A person turning one off proves it's them; an admin token (automation) may switch it off.
    expect(await stepUpNeeded(env, ann, 'set_plugin_enabled', { enabled: false })).toBe(true);
    expect(await stepUpNeeded(env, token, 'set_plugin_enabled', { enabled: false })).toBe(false);
    expect(await stepUpNeeded(env, ann, 'set_approval_separation', { on: true })).toBe(false);
  });
});
