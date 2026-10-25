import type { Principal } from '@orderloop/core';
import { apiTokens, passkeys, sessions } from '@orderloop/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

/** What the next `select … get()` reads, in order; what was written, and to which table. */
let rows: unknown[] = [];
let writes: { table: unknown; op: 'update' | 'delete'; set?: unknown }[] = [];
/** How many rows each table's write `returning()` reports. */
let returned = new Map<unknown, number>();
const done = (table: unknown) =>
  Object.assign(Promise.resolve(), {
    returning: async () => Array.from({ length: returned.get(table) ?? 0 }, (_, i) => ({ id: i })),
  });
const fakeDb = {
  select: () => {
    const q = { from: () => q, where: () => q, get: async () => rows.shift() };
    return q;
  },
  insert: () => ({ values: async () => {} }),
  update: (table: unknown) => ({
    set: (set: unknown) => ({
      where: () => {
        writes.push({ table, op: 'update', set });
        return done(table);
      },
    }),
  }),
  delete: (table: unknown) => ({
    where: () => {
      writes.push({ table, op: 'delete' });
      return done(table);
    },
  }),
};
/** Connected apps, a page of the provider's listing at a time. */
let grantPages: { items: { id: string }[]; cursor?: string }[] = [];
const revokeGrant = vi.fn(async () => {});
const audit = vi.fn(async () => {});

const dropA2aPushes = vi.fn(async () => ({ configs: 0 }));
let pepper: string | undefined;
vi.mock('~/lib/env.server', () => ({
  passwordPepper: () => pepper,
  db: () => fakeDb,
  engine: () => ({ dropA2aPushes }),
}));
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/oauth.server', () => ({
  oauthApi: () => ({
    listUserGrants: async (_id: string, o?: { cursor?: string }) =>
      grantPages[o?.cursor ? Number(o.cursor) : 0] ?? { items: [] },
    revokeGrant,
  }),
}));

const { endAccess } = await import('~/lib/access.server');
const { createToken, needsStepUp, resetPassword, setDisabled, setRole, TeamError } = await import(
  '~/lib/team.server'
);
const { resetTwoFactor } = await import('~/lib/two-factor.server');

const admin: Principal = { kind: 'user', id: 'usr_admin', name: 'Boss', role: 'admin' };
const request = new Request('https://app.test/team', { method: 'POST' });
const ann = { email: 'ann@example.com', role: 'admin' };

const touched = () =>
  writes.map((w) =>
    w.table === sessions
      ? 'sessions'
      : w.table === apiTokens
        ? 'tokens'
        : w.table === passkeys
          ? 'passkeys'
          : `${w.op} other`,
  );

beforeEach(() => {
  rows = [];
  writes = [];
  returned = new Map<unknown, number>([
    [sessions, 2],
    [apiTokens, 1],
    [passkeys, 1],
  ]);
  grantPages = [{ items: [{ id: 'grant_1' }, { id: 'grant_2' }] }];
  dropA2aPushes.mockClear();
  revokeGrant.mockClear();
  audit.mockClear();
});

describe('endAccess', () => {
  it('ends only what it is asked to, and counts it', async () => {
    const person = { id: 'usr_ann', email: 'ann@example.com' };
    expect(await endAccess(request, person, { sessions: true })).toEqual({
      sessions: 2,
      apps: 0,
      tokens: 0,
      passkeys: 0,
    });
    expect(touched()).toEqual(['sessions']);
    expect(
      await endAccess(request, person, {
        sessions: { except: 'hash' },
        tokens: true,
        apps: true,
        passkeys: true,
      }),
    ).toEqual({ sessions: 2, apps: 2, tokens: 1, passkeys: 1 });
    expect(revokeGrant.mock.calls).toEqual([
      ['grant_1', 'usr_ann'],
      ['grant_2', 'usr_ann'],
    ]);
    // An A2A app's push configs go with its grant.
    expect(dropA2aPushes).toHaveBeenCalledWith('user', 'usr_ann', ['grant_1', 'grant_2']);
  });

  it('revokes every page of connected apps', async () => {
    grantPages = [
      { items: [{ id: 'grant_1' }], cursor: '1' },
      { items: [{ id: 'grant_2' }], cursor: '2' },
      { items: [{ id: 'grant_3' }] },
    ];
    const ended = await endAccess(request, { id: 'usr_ann', email: 'a@x' }, { apps: true });
    expect(ended.apps).toBe(3);
    expect(revokeGrant).toHaveBeenCalledTimes(3);
  });

  it('has no token above admin to revoke', async () => {
    writes = [];
    await endAccess(request, { id: 'usr_ann', email: 'a@x' }, { tokens: { above: 'admin' } });
    expect(writes).toEqual([]);
  });
});

describe('the Team page ends what no longer fits', () => {
  it('disabling ends sessions, connected apps and their tokens; enabling brings none back', async () => {
    rows = [{ id: 'usr_other_admin' }, ann];
    await setDisabled(request, admin, 'usr_ann', true);
    expect(touched()).toEqual(['update other', 'sessions', 'tokens']);
    expect(revokeGrant).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(request, 'team.user_disabled', {
      actor: admin,
      target: ann.email,
      detail: { sessions: 2, tokens: 1, apps: 2 },
    });

    writes = [];
    revokeGrant.mockClear();
    rows = [ann];
    await setDisabled(request, admin, 'usr_ann', false);
    expect(touched()).toEqual(['update other']);
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('demoting revokes the tokens they made above the new role; promoting revokes none', async () => {
    rows = [{ id: 'usr_other_admin' }, ann];
    await setRole(request, admin, 'usr_ann', 'approver');
    expect(touched()).toEqual(['update other', 'tokens']);
    expect(audit).toHaveBeenCalledWith(request, 'team.role_changed', {
      actor: admin,
      target: ann.email,
      detail: { from: 'admin', to: 'approver', tokens: 1 },
    });

    writes = [];
    rows = [{ id: 'usr_other_admin' }, { ...ann, role: 'viewer' }];
    await setRole(request, admin, 'usr_ann', 'operator');
    expect(touched()).toEqual(['update other']);
  });

  it('a password reset ends sessions, connected apps and passkeys', async () => {
    rows = [ann];
    const { password } = await resetPassword(request, admin, 'usr_ann');
    expect(password).toBeTruthy();
    expect(touched()).toEqual(['update other', 'sessions', 'passkeys']);
    expect(revokeGrant).toHaveBeenCalledTimes(2);
  });

  it('peppers the password a reset sets, when the deployment has a pepper', async () => {
    pepper = 'p'.repeat(64);
    try {
      rows = [ann];
      await resetPassword(request, admin, 'usr_ann');
      const set = writes.find((w) => w.op === 'update')?.set as { passwordHash?: string };
      expect(set.passwordHash).toMatch(/^pbkdf2p:/);
    } finally {
      pepper = undefined;
    }
  });

  it('a two-factor reset ends sessions, connected apps and passkeys too', async () => {
    rows = [{ email: ann.email, enabledAt: 1 }];
    await resetTwoFactor(request, admin, 'usr_ann');
    expect(touched()).toEqual(['sessions', 'passkeys', 'update other', 'delete other']);
    expect(revokeGrant).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(request, 'team.two_factor_reset', {
      actor: admin,
      target: ann.email,
      detail: { sessions: 2, apps: 2, passkeys: 'removed' },
    });
  });

  it('takes back a token whose maker was disabled or demoted while it was being made', async () => {
    const input = { name: 'ERP sync', role: 'admin', lifetime: '30' };
    rows = [{ role: 'admin', disabledAt: null }];
    expect((await createToken(request, admin, input)).token).toMatch(/^ol_live_/);
    expect(touched()).toEqual([]);

    for (const now of [
      { role: 'admin', disabledAt: 5 },
      { role: 'operator', disabledAt: null },
    ]) {
      writes = [];
      rows = [now];
      await expect(createToken(request, admin, input)).rejects.toBeInstanceOf(TeamError);
      expect(touched()).toEqual(['tokens']);
    }
  });
});

describe('which Team page changes ask for a step-up', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it('asks before handing out access, and not for everyday changes', async () => {
    for (const intent of [
      'add-token',
      'scim-token',
      'reset',
      'reset-two-factor',
      'sso-settings',
      'two-factor-requirement',
    ])
      expect(await needsStepUp(intent, form({ intent }))).toBe(true);
    for (const intent of ['disable', 'revoke', 'scim-revoke', 'approval-separation'])
      expect(await needsStepUp(intent, form({ intent }))).toBe(false);
    expect(await needsStepUp('add-user', form({ role: 'operator' }))).toBe(false);
    expect(await needsStepUp('add-user', form({ role: 'admin' }))).toBe(true);
  });

  it('asks before making someone an admin, not when they already are one', async () => {
    rows = [{ role: 'operator' }];
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(true);
    rows = [{ role: 'admin' }];
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'admin' }))).toBe(false);
    expect(await needsStepUp('role', form({ id: 'usr_ann', role: 'viewer' }))).toBe(false);
  });

  it('asks before a group is mapped to Admin, and before enabling anyone above Viewer', async () => {
    expect(await needsStepUp('scim-roles', form({ 'role:grp_1': 'admin' }))).toBe(true);
    expect(
      await needsStepUp('scim-roles', form({ 'role:grp_1': 'operator', 'role:grp_2': '' })),
    ).toBe(false);
    rows = [{ role: 'admin' }];
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(true);
    rows = [{ role: 'viewer' }];
    expect(await needsStepUp('enable', form({ id: 'usr_ann' }))).toBe(false);
  });
});
