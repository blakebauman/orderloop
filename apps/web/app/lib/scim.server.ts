/**
 * SCIM 2.0 provisioning at `/scim/v2`: the workspace's identity provider (Okta, Entra ID, …)
 * creates, updates and deactivates people, and pushes groups that admins map to roles.
 *
 * - **Auth:** a dedicated bearer token (`ol_scim_…`). An admin makes it on the Team page and sees
 *   it once; only its SHA-256 is kept, in `workspace_settings` (`scim_token`).
 * - **People:** `userName` is the email. A person SCIM adds has no password and signs in with
 *   single sign-on. `active: false` or DELETE disables them and ends their access at once:
 *   sessions, connected apps (OAuth grants) and the API tokens they created. The last active
 *   admin is never disabled or demoted this way (409), so a sync can't lock the team out.
 * - **Groups → roles:** admins map groups to roles (`scim_roles`). Whenever a person's groups or
 *   the map change, their role becomes the highest mapped role of their groups, or viewer.
 *
 * The protocol runs against `ScimStore`, so tests can drive it in memory; `d1Store` is the real one.
 */

import { atLeast, newId, type Principal, type Role } from '@orderloop/core';
import { apiTokens, scimGroupMembers, scimGroups, users, workspaceSettings } from '@orderloop/db';
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { endAccess } from './access.server';
import { audit, clientIp } from './audit.server';
import { randomToken, secretEqual, sha256Hex } from './credentials';
import { db } from './env.server';
import { overBudget } from './rate-limit';
import {
  type Filter,
  type GroupChanges,
  groupFromBody,
  groupPatch,
  groupResource,
  listResponse,
  type PersonChanges,
  page,
  parseFilter,
  personFromBody,
  personPatch,
  readRoleMap,
  roleFromGroups,
  SCIM_CONTENT_TYPE,
  SCIM_ERROR,
  SCIM_GROUP,
  SCIM_PATH,
  SCIM_USER,
  ScimBadRequest,
  type ScimGroupRow,
  type ScimPerson,
  userResource,
} from './scim';

export const SCIM_TOKEN_PREFIX = 'ol_scim_';
const TOKEN_KEY = 'scim_token';
const ROLES_KEY = 'scim_roles';

/** Who SCIM changes are recorded as in the audit log. */
export const SCIM_ACTOR: Principal = { kind: 'token', id: 'scim', name: 'SCIM', role: 'admin' };

/** What the protocol reads and writes. */
export interface ScimStore {
  people(
    f: Filter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: ScimPerson[] }>;
  person(id: string): Promise<ScimPerson | undefined>;
  personByEmail(email: string): Promise<ScimPerson | undefined>;
  addPerson(p: ScimPerson): Promise<void>;
  updatePerson(
    id: string,
    set: { email?: string; name?: string; scimExternalId?: string | null },
  ): Promise<void>;
  role(id: string): Promise<Role>;
  setRole(id: string, role: Role): Promise<void>;
  /** Active admins other than `exceptId`. */
  otherAdmins(exceptId: string): Promise<number>;
  setDisabled(id: string, at: number | null): Promise<void>;
  /** Revokes the API tokens a person made with a role above `role`: how many. */
  revokeTokensAbove(p: { id: string; email: string }, role: Role): Promise<number>;
  /** Ends a person's sessions, connected apps and the API tokens they created. */
  revokeAccess(p: {
    id: string;
    email: string;
  }): Promise<{ sessions: number; apps: number; tokens: number }>;
  groups(
    f: Filter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: ScimGroupRow[] }>;
  group(id: string): Promise<ScimGroupRow | undefined>;
  addGroup(g: ScimGroupRow): Promise<void>;
  updateGroup(
    id: string,
    set: { displayName?: string; externalId?: string | null; updatedAt: number },
  ): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  members(groupId: string): Promise<string[]>;
  /** Of these ids, the ones that are people. */
  existing(ids: string[]): Promise<string[]>;
  addMembers(groupId: string, ids: string[]): Promise<void>;
  removeMembers(groupId: string, ids: string[]): Promise<void>;
  /** Removes a person from every group. */
  leaveGroups(userId: string): Promise<void>;
  groupsOf(userId: string): Promise<string[]>;
  roleMap(): Promise<Record<string, Role>>;
}

type Audit = (action: Parameters<typeof audit>[1], e: Parameters<typeof audit>[2]) => Promise<void>;

// ── Responses ──

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': SCIM_CONTENT_TYPE, ...headers },
  });

export const scimError = (status: number, detail: string, scimType?: string) =>
  json(
    { schemas: [SCIM_ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) },
    status,
  );

class Conflict extends Error {
  constructor(
    message: string,
    readonly scimType?: 'uniqueness',
  ) {
    super(message);
  }
}
class NotFound extends Error {}

// ── The protocol ──

/** Serves one authenticated SCIM request (`path` is what follows `/scim/v2`). */
export async function handleScim(
  request: Request,
  path: string,
  store: ScimStore,
  record: Audit,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const base = `${url.origin}${SCIM_PATH}`;
  const [, kind, id, extra] = path.split('/');
  const method = request.method;
  try {
    if (extra !== undefined) throw new NotFound();
    if (kind === 'ServiceProviderConfig' && method === 'GET')
      return json(serviceProviderConfig(base));
    if (kind === 'ResourceTypes' && method === 'GET') return json(resourceTypes(base));
    if (kind === 'Schemas' && method === 'GET') return json(listResponse([], 0, 1));
    const body =
      method === 'POST' || method === 'PUT' || method === 'PATCH'
        ? ((await request.json().catch(() => {
            throw new ScimBadRequest('The body is not JSON', 'invalidSyntax');
          })) as Record<string, unknown>)
        : {};
    const people = new People(store, record, now);
    if (kind === 'Users') {
      if (!id) {
        if (method === 'GET') {
          const { start, offset, limit } = page(url.searchParams);
          const { total, rows } = await store.people(
            parseFilter(url.searchParams.get('filter')),
            offset,
            limit,
          );
          return json(
            listResponse(
              rows.map((p) => userResource(p, base)),
              total,
              start,
            ),
          );
        }
        if (method === 'POST') {
          const p = await people.create(personFromBody(body));
          return json(userResource(p, base), 201, { location: `${base}/Users/${p.id}` });
        }
      } else {
        const p = await store.person(id);
        if (!p) throw new NotFound();
        if (method === 'GET') return json(userResource(p, base));
        if (method === 'PUT' || method === 'PATCH') {
          const changes = method === 'PUT' ? personFromBody(body) : personPatch(body);
          return json(userResource(await people.update(p, changes), base));
        }
        if (method === 'DELETE') {
          await people.update(p, { active: false });
          await store.leaveGroups(p.id);
          return new Response(null, { status: 204 });
        }
      }
    }
    if (kind === 'Groups') {
      const groups = new Groups(store, people, now);
      const withMembers = !/\bmembers\b/i.test(url.searchParams.get('excludedAttributes') ?? '');
      const render = async (g: ScimGroupRow) =>
        groupResource(g, withMembers ? await store.members(g.id) : [], base);
      if (!id) {
        if (method === 'GET') {
          const { start, offset, limit } = page(url.searchParams);
          const { total, rows } = await store.groups(
            parseFilter(url.searchParams.get('filter')),
            offset,
            limit,
          );
          return json(listResponse(await Promise.all(rows.map(render)), total, start));
        }
        if (method === 'POST') {
          const g = await groups.create(groupFromBody(body));
          return json(groupResource(g, await store.members(g.id), base), 201, {
            location: `${base}/Groups/${g.id}`,
          });
        }
      } else {
        const g = await store.group(id);
        if (!g) throw new NotFound();
        if (method === 'GET') return json(await render(g));
        if (method === 'PUT' || method === 'PATCH') {
          const changes = method === 'PUT' ? groupFromBody(body) : groupPatch(body);
          const next = await groups.update(g, changes);
          // Entra expects 204 for a PATCH; a body is allowed and Okta reads it.
          return json(groupResource(next, await store.members(g.id), base));
        }
        if (method === 'DELETE') {
          await groups.remove(g);
          return new Response(null, { status: 204 });
        }
      }
    }
    return scimError(404, 'No such SCIM resource');
  } catch (err) {
    if (err instanceof ScimBadRequest) return scimError(400, err.message, err.scimType);
    if (err instanceof NotFound) return scimError(404, 'No such resource');
    if (err instanceof Conflict) return scimError(409, err.message, err.scimType);
    throw err;
  }
}

/** People: creating, changing and (de)activating, with the last admin kept. */
class People {
  constructor(
    private store: ScimStore,
    private record: Audit,
    private now: number,
    /** Who changes are recorded as: SCIM, or the admin whose group map moved roles. */
    private actor: Principal = SCIM_ACTOR,
  ) {}

  async create(c: PersonChanges & { email: string }): Promise<ScimPerson> {
    if (await this.store.personByEmail(c.email))
      throw new Conflict(`${c.email} is already on the team`, 'uniqueness');
    const p: ScimPerson = {
      id: newId('usr'),
      email: c.email,
      name: c.name ?? c.email.split('@')[0]!,
      disabledAt: c.active === false ? this.now : null,
      scimExternalId: c.externalId ?? null,
      createdAt: this.now,
    };
    await this.store.addPerson(p);
    await this.record('team.user_added', {
      actor: this.actor,
      target: p.email,
      detail: { role: 'viewer', via: 'scim', ...(p.disabledAt ? { active: false } : {}) },
    });
    return p;
  }

  async update(p: ScimPerson, c: PersonChanges): Promise<ScimPerson> {
    // Tokens were made under the address they had before this change.
    const before = { id: p.id, email: p.email };
    const set: { email?: string; name?: string; scimExternalId?: string | null } = {};
    if (c.email && c.email !== p.email) {
      const taken = await this.store.personByEmail(c.email);
      if (taken && taken.id !== p.id)
        throw new Conflict(`${c.email} is already on the team`, 'uniqueness');
      set.email = c.email;
    }
    if (c.name && c.name !== p.name) set.name = c.name;
    if (c.externalId !== undefined && c.externalId !== p.scimExternalId)
      set.scimExternalId = c.externalId;
    if (Object.keys(set).length) {
      await this.store.updatePerson(p.id, set);
      if (set.email || set.name)
        await this.record('team.user_updated', {
          actor: this.actor,
          target: p.email,
          detail: {
            ...(set.email ? { email: set.email } : {}),
            ...(set.name ? { name: set.name } : {}),
            via: 'scim',
          },
        });
    }
    let disabledAt = p.disabledAt;
    if (c.active === false && p.disabledAt === null) {
      await this.keepAnAdmin(p.id, 'deactivate');
      disabledAt = this.now;
      await this.store.setDisabled(p.id, disabledAt);
      const ended = await this.store.revokeAccess(before);
      await this.record('team.user_disabled', {
        actor: this.actor,
        target: set.email ?? p.email,
        detail: { via: 'scim', ...ended },
      });
    } else if (c.active === true && p.disabledAt !== null) {
      disabledAt = null;
      await this.store.setDisabled(p.id, null);
      await this.record('team.user_enabled', {
        actor: this.actor,
        target: set.email ?? p.email,
        detail: { via: 'scim' },
      });
    }
    return {
      ...p,
      email: set.email ?? p.email,
      name: set.name ?? p.name,
      scimExternalId: set.scimExternalId !== undefined ? set.scimExternalId : p.scimExternalId,
      disabledAt,
    };
  }

  /** Sets a person's role from their groups. The last active admin keeps theirs. */
  async syncRole(userId: string, map: Record<string, Role>) {
    const p = await this.store.person(userId);
    if (!p) return;
    const from = await this.store.role(userId);
    const to = roleFromGroups(await this.store.groupsOf(userId), map);
    if (from === to) return;
    if (from === 'admin' && p.disabledAt === null && !(await this.store.otherAdmins(userId))) {
      await this.record('team.role_changed', {
        actor: this.actor,
        target: p.email,
        detail: { from, to: from, via: 'scim', kept: 'the last active admin' },
      });
      return;
    }
    await this.store.setRole(userId, to);
    // As on the Team page: tokens they made above the new role go; apps follow the role live.
    const tokens = atLeast(to, from) ? 0 : await this.store.revokeTokensAbove(p, to);
    await this.record('team.role_changed', {
      actor: this.actor,
      target: p.email,
      detail: { from, to, via: 'scim', ...(tokens ? { tokens } : {}) },
    });
  }

  private async keepAnAdmin(id: string, what: string) {
    if ((await this.store.role(id)) === 'admin' && !(await this.store.otherAdmins(id)))
      throw new Conflict(
        `Can't ${what} the last active admin: make someone else an admin in OrderLoop first`,
      );
  }
}

/** Groups and their members; every membership change re-derives the members' roles. */
class Groups {
  constructor(
    private store: ScimStore,
    private people: People,
    private now: number,
  ) {}

  async create(c: GroupChanges & { displayName: string }): Promise<ScimGroupRow> {
    const g: ScimGroupRow = {
      id: newId('grp'),
      displayName: c.displayName,
      externalId: c.externalId ?? null,
      createdAt: this.now,
      updatedAt: this.now,
    };
    await this.store.addGroup(g);
    await this.update(g, { members: c.members ?? [], add: [], remove: [] });
    return g;
  }

  async update(g: ScimGroupRow, c: GroupChanges): Promise<ScimGroupRow> {
    const set: { displayName?: string; externalId?: string | null; updatedAt: number } = {
      updatedAt: this.now,
    };
    if (c.displayName !== undefined) set.displayName = c.displayName;
    if (c.externalId !== undefined) set.externalId = c.externalId;
    await this.store.updateGroup(g.id, set);
    const before = new Set(await this.store.members(g.id));
    let after = new Set(before);
    if (c.members) after = new Set(await this.store.existing(c.members));
    for (const id of await this.store.existing(c.add)) after.add(id);
    for (const id of c.remove) after.delete(id);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    if (added.length) await this.store.addMembers(g.id, added);
    if (removed.length) await this.store.removeMembers(g.id, removed);
    if (added.length || removed.length) {
      const map = await this.store.roleMap();
      // Only a mapped group moves anyone's role.
      if (map[g.id]) for (const id of [...added, ...removed]) await this.people.syncRole(id, map);
    }
    return { ...g, ...set } as ScimGroupRow;
  }

  async remove(g: ScimGroupRow) {
    const members = await this.store.members(g.id);
    const map = await this.store.roleMap();
    await this.store.deleteGroup(g.id);
    if (map[g.id]) {
      const { [g.id]: _gone, ...rest } = map;
      for (const id of members) await this.people.syncRole(id, rest);
    }
  }
}

/** Re-derives the role of every member of these groups, after admins changed the map. */
export async function syncGroupRoles(
  store: ScimStore,
  record: Audit,
  groupIds: string[],
  map: Record<string, Role>,
  by: Principal,
) {
  const people = new People(store, record, Date.now(), by);
  const ids = new Set<string>();
  for (const g of groupIds) for (const id of await store.members(g)) ids.add(id);
  for (const id of ids) await people.syncRole(id, map);
}

function serviceProviderConfig(base: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://docs.orderloop.app/guides/team-and-roles/#provisioning-with-scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'The SCIM token an admin creates on the Team page',
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

function resourceTypes(base: string) {
  const type = (name: string, schema: string) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: name,
    name,
    endpoint: `/${name}s`,
    schema,
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${name}` },
  });
  return listResponse([type('User', SCIM_USER), type('Group', SCIM_GROUP)], 2, 1);
}

// ── The token ──

/** Whether SCIM is on (a token exists), and the request carries it. */
export async function scimAuthorized(request: Request): Promise<boolean> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!bearer?.startsWith(SCIM_TOKEN_PREFIX)) return false;
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, TOKEN_KEY))
    .get();
  return !!row && (await secretEqual(await sha256Hex(bearer), row.value));
}

export async function scimTokenSet(): Promise<{ updatedAt: number; updatedBy: string } | null> {
  return (
    (await db()
      .select({ updatedAt: workspaceSettings.updatedAt, updatedBy: workspaceSettings.updatedBy })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.key, TOKEN_KEY))
      .get()) ?? null
  );
}

/** Makes a new SCIM token (replacing any other) and returns it, to show once. */
export async function createScimToken(request: Request, by: Principal): Promise<string> {
  const token = `${SCIM_TOKEN_PREFIX}${randomToken(24)}`;
  const value = await sha256Hex(token);
  const updatedBy = by.email ?? by.name;
  const now = Date.now();
  const replaced = !!(await scimTokenSet());
  await db()
    .insert(workspaceSettings)
    .values({ key: TOKEN_KEY, value, updatedAt: now, updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: now, updatedBy },
    });
  await audit(request, 'scim.token_created', { actor: by, detail: { replaced } });
  return token;
}

export async function revokeScimToken(request: Request, by: Principal) {
  await db().delete(workspaceSettings).where(eq(workspaceSettings.key, TOKEN_KEY));
  await audit(request, 'scim.token_revoked', { actor: by });
}

// ── Groups → roles, from the Team page ──

export async function scimGroupsWithRoles() {
  const [rows, map] = await Promise.all([
    db()
      .select({
        id: scimGroups.id,
        displayName: scimGroups.displayName,
        members: count(scimGroupMembers.userId),
      })
      .from(scimGroups)
      .leftJoin(scimGroupMembers, eq(scimGroupMembers.groupId, scimGroups.id))
      .groupBy(scimGroups.id)
      .orderBy(scimGroups.displayName)
      .all(),
    d1RoleMap(),
  ]);
  return rows.map((g) => ({ ...g, role: map[g.id] ?? null }));
}

/** Saves the group → role map and moves the roles of the changed groups' members. */
export async function setScimRoles(request: Request, by: Principal, next: Record<string, Role>) {
  const from = await d1RoleMap();
  const changed = [...new Set([...Object.keys(from), ...Object.keys(next)])].filter(
    (g) => from[g] !== next[g],
  );
  if (!changed.length) return;
  const value = JSON.stringify(next);
  const updatedBy = by.email ?? by.name;
  await db()
    .insert(workspaceSettings)
    .values({ key: ROLES_KEY, value, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: Date.now(), updatedBy },
    });
  await audit(request, 'team.scim_roles', { actor: by, detail: { from, to: next } });
  await syncGroupRoles(d1Store(request), (a, e) => audit(request, a, e), changed, next, by);
}

async function d1RoleMap() {
  const row = await db()
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, ROLES_KEY))
    .get();
  return readRoleMap(row?.value);
}

// ── D1 ──

const personCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  disabledAt: users.disabledAt,
  scimExternalId: users.scimExternalId,
  createdAt: users.createdAt,
};

const personWhere = (f: Filter | null) =>
  !f
    ? undefined
    : f.attr === 'userName'
      ? eq(users.email, f.value.toLowerCase())
      : f.attr === 'externalId'
        ? eq(users.scimExternalId, f.value)
        : f.attr === 'id'
          ? eq(users.id, f.value)
          : eq(users.name, f.value);

const groupWhere = (f: Filter | null) =>
  !f
    ? undefined
    : f.attr === 'externalId'
      ? eq(scimGroups.externalId, f.value)
      : f.attr === 'id'
        ? eq(scimGroups.id, f.value)
        : eq(scimGroups.displayName, f.value);

/** The store over D1. `request` is for revoking OAuth grants, which live with the provider. */
export function d1Store(request: Request): ScimStore {
  return {
    async people(f, offset, limit) {
      const where = personWhere(f);
      const [total, rows] = await Promise.all([
        db().select({ n: count() }).from(users).where(where).get(),
        limit
          ? db()
              .select(personCols)
              .from(users)
              .where(where)
              .orderBy(users.createdAt)
              .limit(limit)
              .offset(offset)
              .all()
          : [],
      ]);
      return { total: total?.n ?? 0, rows };
    },
    person: (id) => db().select(personCols).from(users).where(eq(users.id, id)).get(),
    personByEmail: (email) =>
      db().select(personCols).from(users).where(eq(users.email, email)).get(),
    async addPerson(p) {
      await db()
        .insert(users)
        .values({ ...p, role: 'viewer' });
    },
    async updatePerson(id, set) {
      if (set.email) {
        // Tokens made before their maker's id was kept are matched by the address they were made
        // under; tie them to the person before that address changes.
        const was = await db()
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, id))
          .get();
        if (was)
          await db()
            .update(apiTokens)
            .set({ createdById: id })
            .where(and(isNull(apiTokens.createdById), eq(apiTokens.createdBy, was.email)));
      }
      await db().update(users).set(set).where(eq(users.id, id));
    },
    async role(id) {
      const r = await db().select({ role: users.role }).from(users).where(eq(users.id, id)).get();
      return (r?.role ?? 'viewer') as Role;
    },
    async setRole(id, role) {
      await db().update(users).set({ role }).where(eq(users.id, id));
    },
    async otherAdmins(exceptId) {
      const r = await db()
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, exceptId)))
        .get();
      return r?.n ?? 0;
    },
    async setDisabled(id, at) {
      await db().update(users).set({ disabledAt: at }).where(eq(users.id, id));
    },
    async revokeTokensAbove(p, role) {
      return (await endAccess(request, p, { tokens: { above: role } })).tokens;
    },
    async revokeAccess(p) {
      const { sessions, apps, tokens } = await endAccess(request, p, {
        sessions: true,
        tokens: true,
        apps: true,
      });
      return { sessions, apps, tokens };
    },
    async groups(f, offset, limit) {
      const where = groupWhere(f);
      const [total, rows] = await Promise.all([
        db().select({ n: count() }).from(scimGroups).where(where).get(),
        limit
          ? db()
              .select()
              .from(scimGroups)
              .where(where)
              .orderBy(scimGroups.createdAt)
              .limit(limit)
              .offset(offset)
              .all()
          : [],
      ]);
      return { total: total?.n ?? 0, rows };
    },
    group: (id) => db().select().from(scimGroups).where(eq(scimGroups.id, id)).get(),
    async addGroup(g) {
      await db().insert(scimGroups).values(g);
    },
    async updateGroup(id, set) {
      await db().update(scimGroups).set(set).where(eq(scimGroups.id, id));
    },
    async deleteGroup(id) {
      await db().delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, id));
      await db().delete(scimGroups).where(eq(scimGroups.id, id));
    },
    async members(groupId) {
      const rows = await db()
        .select({ id: scimGroupMembers.userId })
        .from(scimGroupMembers)
        .where(eq(scimGroupMembers.groupId, groupId))
        .all();
      return rows.map((r) => r.id);
    },
    async existing(ids) {
      if (!ids.length) return [];
      const found = new Set<string>();
      // D1 binds at most 100 parameters a statement.
      for (let i = 0; i < ids.length; i += 90) {
        const rows = await db()
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, ids.slice(i, i + 90)))
          .all();
        for (const r of rows) found.add(r.id);
      }
      return ids.filter((id) => found.has(id));
    },
    async addMembers(groupId, ids) {
      for (let i = 0; i < ids.length; i += 40)
        await db()
          .insert(scimGroupMembers)
          .values(ids.slice(i, i + 40).map((userId) => ({ groupId, userId })))
          .onConflictDoNothing();
    },
    async removeMembers(groupId, ids) {
      for (let i = 0; i < ids.length; i += 90)
        await db()
          .delete(scimGroupMembers)
          .where(
            and(
              eq(scimGroupMembers.groupId, groupId),
              inArray(scimGroupMembers.userId, ids.slice(i, i + 90)),
            ),
          );
    },
    async leaveGroups(userId) {
      await db().delete(scimGroupMembers).where(eq(scimGroupMembers.userId, userId));
    },
    async groupsOf(userId) {
      const rows = await db()
        .select({ id: scimGroupMembers.groupId })
        .from(scimGroupMembers)
        .where(eq(scimGroupMembers.userId, userId))
        .all();
      return rows.map((r) => r.id);
    },
    roleMap: d1RoleMap,
  };
}

/** `/scim/v2/*` on the web Worker: the token, a budget, then the protocol. */
export async function scimFetch(request: Request): Promise<Response> {
  // Each guess costs a lookup: a budget per address before the token is checked.
  const guessing = await overBudget('API_LIMIT', `scim:${clientIp(request)}`);
  if (guessing) return guessing;
  if (!(await scimAuthorized(request)))
    return scimError(401, 'A valid SCIM token is required (Team page → SCIM provisioning)');
  const limited = await overBudget('API_LIMIT', 'scim');
  if (limited) return limited;
  const path = new URL(request.url).pathname.slice(SCIM_PATH.length) || '/';
  return handleScim(request, path, d1Store(request), (a, e) => audit(request, a, e));
}
