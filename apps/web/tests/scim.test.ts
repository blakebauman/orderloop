import type { Role } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Filter,
  groupPatch,
  parseFilter,
  personFromBody,
  personPatch,
  roleFromGroups,
  ScimBadRequest,
  type ScimGroupRow,
  type ScimPerson,
} from '~/lib/scim';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => ({}) }));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn() }));
vi.mock('~/lib/oauth.server', () => ({ oauthApi: vi.fn() }));
vi.mock('~/lib/rate-limit', () => ({ overBudget: async () => null }));

const { handleScim } = await import('~/lib/scim.server');
type Store = Parameters<typeof handleScim>[2];
// biome-ignore lint/suspicious/noExplicitAny: SCIM response bodies, read loosely
type Json = Record<string, any>;

describe('SCIM parsing', () => {
  it('reads the eq filters identity providers send, and refuses the rest', () => {
    expect(parseFilter('userName eq "Ann@Example.com"')).toEqual({
      attr: 'userName',
      value: 'Ann@Example.com',
    });
    expect(parseFilter('externalId eq "00u1"')).toEqual({ attr: 'externalId', value: '00u1' });
    expect(parseFilter('displayName eq "Ops \\"West\\""')).toEqual({
      attr: 'displayName',
      value: 'Ops "West"',
    });
    expect(parseFilter(null)).toBeNull();
    expect(() => parseFilter('userName sw "a"')).toThrow(ScimBadRequest);
    expect(() => parseFilter('title eq "x"')).toThrow(ScimBadRequest);
  });

  it('reads a User, with userName as the email', () => {
    expect(
      personFromBody({
        userName: 'Ann@Example.com',
        name: { givenName: 'Ann', familyName: 'Lee' },
        externalId: 'ext-1',
      }),
    ).toEqual({ email: 'ann@example.com', name: 'Ann Lee', active: true, externalId: 'ext-1' });
    // Entra may send a userName that isn't an email, with the address in emails.
    expect(
      personFromBody({
        userName: 'ann',
        emails: [{ value: 'ann@example.com', primary: true }],
        active: 'False',
      }).active,
    ).toBe(false);
    expect(() => personFromBody({ userName: 'ann' })).toThrow(/email/);
  });

  it('reads Entra’s and Okta’s User PATCH shapes', () => {
    // Entra: capitalised ops, string booleans, a path per attribute.
    expect(
      personPatch({
        Operations: [
          { op: 'Replace', path: 'active', value: 'False' },
          { op: 'Replace', path: 'name.givenName', value: 'Ann' },
          { op: 'Replace', path: 'name.familyName', value: 'Lee' },
          { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ann@new.com' },
          { op: 'Add', path: 'title', value: 'Buyer' },
        ],
      }),
    ).toEqual({ active: false, name: 'Ann Lee', email: 'ann@new.com' });
    // Okta: a path-less replace with an object.
    expect(personPatch({ Operations: [{ op: 'replace', value: { active: true } }] })).toEqual({
      active: true,
    });
    expect(() => personPatch({ Operations: [{ op: 'move', path: 'active' }] })).toThrow();
    expect(() => personPatch({})).toThrow(/Operations/);
  });

  it('reads Group PATCH shapes: add, filtered remove, remove-by-value, replace and rename', () => {
    expect(
      groupPatch({
        Operations: [
          { op: 'Add', path: 'members', value: [{ value: 'u1' }, { value: 'u2' }] },
          { op: 'Remove', path: 'members[value eq "u3"]' },
          { op: 'Remove', path: 'members', value: [{ value: 'u4' }] },
          { op: 'replace', value: { displayName: 'Buyers' } },
        ],
      }),
    ).toEqual({ add: ['u1', 'u2'], remove: ['u3', 'u4'], displayName: 'Buyers' });
    expect(
      groupPatch({ Operations: [{ op: 'replace', path: 'members', value: [{ value: 'u9' }] }] })
        .members,
    ).toEqual(['u9']);
  });

  it('gives the highest mapped role of someone’s groups, or viewer', () => {
    const map: Record<string, Role> = { g1: 'approver', g2: 'admin' };
    expect(roleFromGroups(['g1', 'g2', 'g3'], map)).toBe('admin');
    expect(roleFromGroups(['g1'], map)).toBe('approver');
    expect(roleFromGroups(['g3'], map)).toBe('viewer');
  });
});

/** The store in memory: people with roles, groups with members, and what was revoked. */
function memoryStore() {
  const people = new Map<string, ScimPerson & { role: Role }>();
  const groups = new Map<string, ScimGroupRow>();
  const members = new Map<string, Set<string>>();
  const map: Record<string, Role> = {};
  const revoked: string[] = [];
  /** The address each revoke matched tokens by: the one they were made under. */
  const revokedAs: string[] = [];
  /** Demotions' token revokes, as `<id>><role>`. */
  const revokedAbove: string[] = [];
  const match = (f: Filter | null, p: ScimPerson) =>
    !f ||
    (f.attr === 'userName' && p.email === f.value.toLowerCase()) ||
    (f.attr === 'externalId' && p.scimExternalId === f.value) ||
    (f.attr === 'id' && p.id === f.value);
  const store: Store = {
    async people(f, offset, limit) {
      const all = [...people.values()].filter((p) => match(f, p));
      return { total: all.length, rows: all.slice(offset, offset + limit) };
    },
    person: async (id) => people.get(id),
    personByEmail: async (email) => [...people.values()].find((p) => p.email === email),
    async addPerson(p) {
      people.set(p.id, { ...p, role: 'viewer' });
    },
    async updatePerson(id, set) {
      Object.assign(people.get(id)!, set);
    },
    role: async (id) => people.get(id)?.role ?? 'viewer',
    async setRole(id, role) {
      people.get(id)!.role = role;
    },
    otherAdmins: async (except) =>
      [...people.values()].filter((p) => p.role === 'admin' && !p.disabledAt && p.id !== except)
        .length,
    async setDisabled(id, at) {
      people.get(id)!.disabledAt = at;
    },
    async revokeTokensAbove(p, role) {
      revokedAbove.push(`${p.id}>${role}`);
      return 1;
    },
    async revokeAccess(p) {
      revoked.push(p.id);
      revokedAs.push(p.email);
      return { sessions: 1, apps: 0, tokens: 0 };
    },
    async groups(f, offset, limit) {
      const all = [...groups.values()].filter(
        (g) => !f || (f.attr === 'displayName' && g.displayName === f.value),
      );
      return { total: all.length, rows: all.slice(offset, offset + limit) };
    },
    group: async (id) => groups.get(id),
    async addGroup(g) {
      groups.set(g.id, { ...g });
      members.set(g.id, new Set());
    },
    async updateGroup(id, set) {
      Object.assign(groups.get(id)!, set);
    },
    async deleteGroup(id) {
      groups.delete(id);
      members.delete(id);
    },
    members: async (g) => [...(members.get(g) ?? [])],
    existing: async (ids) => ids.filter((id) => people.has(id)),
    async addMembers(g, ids) {
      for (const id of ids) members.get(g)!.add(id);
    },
    async removeMembers(g, ids) {
      for (const id of ids) members.get(g)!.delete(id);
    },
    async leaveGroups(userId) {
      for (const m of members.values()) m.delete(userId);
    },
    groupsOf: async (userId) => [...members].filter(([, m]) => m.has(userId)).map(([g]) => g),
    roleMap: async () => map,
  };
  return { store, people, map, revoked, revokedAs, revokedAbove };
}

describe('the SCIM protocol', () => {
  let mem: ReturnType<typeof memoryStore>;
  const record = vi.fn(async () => {});

  beforeEach(() => {
    mem = memoryStore();
    record.mockClear();
    // The admin who set things up, outside SCIM.
    mem.people.set('usr_admin', {
      id: 'usr_admin',
      email: 'boss@example.com',
      name: 'Boss',
      role: 'admin',
      disabledAt: null,
      scimExternalId: null,
      createdAt: 0,
    });
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleScim(
      new Request(`https://app.test/scim/v2${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      path.split('?')[0]!,
      mem.store,
      record,
      1_000,
    );
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as Json };
  };

  it('creates a person once, finds them by userName, and refuses a duplicate', async () => {
    const created = await call('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'ann@example.com',
      name: { givenName: 'Ann', familyName: 'Lee' },
      externalId: '00u1',
      active: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      userName: 'ann@example.com',
      active: true,
      externalId: '00u1',
    });
    expect(mem.people.get(created.body.id)?.role).toBe('viewer');

    const found = await call('GET', '/Users?filter=userName%20eq%20%22ann@example.com%22');
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources[0].id).toBe(created.body.id);
    expect(
      (await call('GET', '/Users?filter=userName%20eq%20%22nobody@x.com%22')).body.totalResults,
    ).toBe(0);

    const again = await call('POST', '/Users', { userName: 'ANN@example.com' });
    expect(again).toMatchObject({ status: 409, body: { scimType: 'uniqueness' } });
  });

  it('deactivating ends access; reactivating lets them back; DELETE deactivates and leaves groups', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    const off = await call('PATCH', `/Users/${ann.id}`, {
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.body.active).toBe(false);
    expect(mem.revoked).toEqual([ann.id]);
    expect(record).toHaveBeenCalledWith(
      'team.user_disabled',
      expect.objectContaining({ target: 'ann@example.com' }),
    );

    const on = await call('PATCH', `/Users/${ann.id}`, {
      Operations: [{ op: 'replace', value: { active: true } }],
    });
    expect(on.body.active).toBe(true);

    const { body: g } = await call('POST', '/Groups', {
      displayName: 'Buyers',
      members: [{ value: ann.id }],
    });
    expect((await call('DELETE', `/Users/${ann.id}`)).status).toBe(204);
    expect(mem.people.get(ann.id)?.disabledAt).toBe(1_000);
    expect((await call('GET', `/Groups/${g.id}`)).body.members).toEqual([]);
  });

  it('revokes by the address tokens were made under when a rename and a deactivate come together', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    await call('PATCH', `/Users/${ann.id}`, {
      Operations: [
        { op: 'replace', path: 'userName', value: 'ann@new.example' },
        { op: 'replace', path: 'active', value: false },
      ],
    });
    expect(mem.revoked).toEqual([ann.id]);
    expect(mem.revokedAs).toEqual(['ann@example.com']);
  });

  it('never deactivates the last active admin', async () => {
    const res = await call('PATCH', '/Users/usr_admin', {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(res.status).toBe(409);
    expect(mem.people.get('usr_admin')?.disabledAt).toBeNull();
  });

  it('roles follow mapped groups: highest wins, leaving drops to viewer, the last admin stays', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    const { body: ops } = await call('POST', '/Groups', { displayName: 'Ops' });
    const { body: admins } = await call('POST', '/Groups', { displayName: 'Admins' });
    mem.map[ops.id] = 'operator';
    mem.map[admins.id] = 'admin';

    await call('PATCH', `/Groups/${ops.id}`, {
      Operations: [
        { op: 'Add', path: 'members', value: [{ value: ann.id }, { value: 'usr_ghost' }] },
      ],
    });
    expect(mem.people.get(ann.id)?.role).toBe('operator');
    expect(
      (await call('GET', `/Groups/${ops.id}`)).body.members.map((m: { value: string }) => m.value),
    ).toEqual([ann.id]);

    await call('PATCH', `/Groups/${admins.id}`, {
      Operations: [
        { op: 'add', path: 'members', value: [{ value: ann.id }, { value: 'usr_admin' }] },
      ],
    });
    expect(mem.people.get(ann.id)?.role).toBe('admin');

    await call('PATCH', `/Groups/${admins.id}`, {
      Operations: [{ op: 'Remove', path: `members[value eq "${ann.id}"]` }],
    });
    expect(mem.people.get(ann.id)?.role).toBe('operator');

    // Deleting the admins group would demote the last admin: they keep it.
    expect((await call('DELETE', `/Groups/${admins.id}`)).status).toBe(204);
    expect(mem.people.get('usr_admin')?.role).toBe('admin');

    await call('PATCH', `/Groups/${ops.id}`, {
      Operations: [{ op: 'replace', path: 'members', value: [] }],
    });
    expect(mem.people.get(ann.id)?.role).toBe('viewer');
    // Each demotion took back the tokens they made above the new role; promotions took none.
    expect(mem.revokedAbove).toEqual([`${ann.id}>operator`, `${ann.id}>viewer`]);
  });

  it('an unmapped group changes nobody’s role', async () => {
    const { body: ann } = await call('POST', '/Users', { userName: 'ann@example.com' });
    mem.people.get(ann.id)!.role = 'approver';
    await call('POST', '/Groups', { displayName: 'Everyone', members: [{ value: ann.id }] });
    expect(mem.people.get(ann.id)?.role).toBe('approver');
  });

  it('answers discovery, errors in SCIM shape, and 404 for the unknown', async () => {
    expect((await call('GET', '/ServiceProviderConfig')).body.patch.supported).toBe(true);
    expect((await call('GET', '/ResourceTypes')).body.totalResults).toBe(2);
    expect(await call('GET', '/Users/usr_nobody')).toMatchObject({
      status: 404,
      body: { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'] },
    });
    expect((await call('GET', '/Users?filter=title%20eq%20%22x%22')).body.scimType).toBe(
      'invalidFilter',
    );
    expect((await call('GET', '/Widgets')).status).toBe(404);
  });

  it('pages with 1-based startIndex and count', async () => {
    for (const n of [1, 2, 3]) await call('POST', '/Users', { userName: `p${n}@example.com` });
    const p = await call('GET', '/Users?startIndex=2&count=2');
    expect(p.body).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
    expect((await call('GET', '/Users?count=0')).body).toMatchObject({
      totalResults: 4,
      itemsPerPage: 0,
    });
  });
});
