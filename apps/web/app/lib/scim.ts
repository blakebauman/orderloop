/**
 * SCIM 2.0 (RFC 7643/7644) shapes and parsing, without bindings: what `scim.server.ts` reads from
 * an identity provider and writes back. Okta and Entra ID each phrase the same change differently
 * (Entra sends `"active": "False"` as a string, capitalised ops and path filters on members; Okta
 * sends path-less replaces with an object value), so the parsers accept both.
 */

import { isRole, ROLES, type Role } from '@orderloop/core';

export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

export const SCIM_PATH = '/scim/v2';
export const SCIM_CONTENT_TYPE = 'application/scim+json';

/** A page: SCIM's `startIndex` is 1-based; `count` is capped. */
export const MAX_PAGE = 200;

export type ScimPerson = {
  id: string;
  email: string;
  name: string;
  disabledAt: number | null;
  scimExternalId: string | null;
  createdAt: number;
};

export type ScimGroupRow = {
  id: string;
  displayName: string;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
};

const iso = (ms: number) => new Date(ms).toISOString();

export function userResource(u: ScimPerson, base: string) {
  const [givenName, ...rest] = u.name.split(' ');
  return {
    schemas: [SCIM_USER],
    id: u.id,
    ...(u.scimExternalId ? { externalId: u.scimExternalId } : {}),
    userName: u.email,
    name: { formatted: u.name, givenName, familyName: rest.join(' ') },
    displayName: u.name,
    emails: [{ value: u.email, type: 'work', primary: true }],
    active: u.disabledAt === null,
    meta: {
      resourceType: 'User',
      created: iso(u.createdAt),
      location: `${base}/Users/${u.id}`,
    },
  };
}

export function groupResource(g: ScimGroupRow, members: string[], base: string) {
  return {
    schemas: [SCIM_GROUP],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.displayName,
    members: members.map((value) => ({ value, $ref: `${base}/Users/${value}` })),
    meta: {
      resourceType: 'Group',
      created: iso(g.createdAt),
      lastModified: iso(g.updatedAt),
      location: `${base}/Groups/${g.id}`,
    },
  };
}

export const listResponse = (resources: unknown[], total: number, startIndex: number) => ({
  schemas: [SCIM_LIST],
  totalResults: total,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

/** The page a list request asks for: a 0-based offset and a limit. */
export function page(params: URLSearchParams) {
  const start = Math.max(1, Number.parseInt(params.get('startIndex') ?? '1', 10) || 1);
  const raw = Number.parseInt(params.get('count') ?? String(MAX_PAGE), 10);
  const count = Math.min(MAX_PAGE, Math.max(0, Number.isNaN(raw) ? MAX_PAGE : raw));
  return { start, offset: start - 1, limit: count };
}

export type Filter = { attr: 'userName' | 'externalId' | 'displayName' | 'id'; value: string };

const FILTER_ATTRS: Record<string, Filter['attr']> = {
  username: 'userName',
  'emails.value': 'userName',
  'emails[type eq "work"].value': 'userName',
  externalid: 'externalId',
  displayname: 'displayName',
  id: 'id',
};

/**
 * The one filter shape identity providers send to find a match: `<attr> eq "<value>"`. Null for
 * no filter; throws for anything else (SCIM's `invalidFilter`).
 */
export function parseFilter(filter: string | null): Filter | null {
  if (!filter?.trim()) return null;
  const m = /^\s*([\w.[\]" ]+?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m ? (FILTER_ATTRS[m[1]!.toLowerCase()] ?? FILTER_ATTRS[m[1]!]) : undefined;
  if (!m || !attr)
    throw new ScimBadRequest(
      `Only "<attribute> eq \\"value\\"" filters on userName, externalId, displayName or id are supported`,
      'invalidFilter',
    );
  return { attr, value: m[2]!.replace(/\\(.)/g, '$1') };
}

export class ScimBadRequest extends Error {
  constructor(
    message: string,
    readonly scimType:
      | 'invalidFilter'
      | 'invalidValue'
      | 'invalidSyntax'
      | 'noTarget' = 'invalidValue',
  ) {
    super(message);
  }
}

/** SCIM booleans as identity providers send them: true, "True", "true". */
function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  throw new ScimBadRequest(`"${String(v)}" is not a boolean`);
}

const text = (v: unknown, max: number) => {
  if (typeof v !== 'string') throw new ScimBadRequest('Expected a string');
  const s = v.trim().slice(0, max);
  if (!s) throw new ScimBadRequest('Expected a non-empty string');
  return s;
};

/** What a request changes about a person. Absent keys stay as they are. */
export type PersonChanges = {
  email?: string;
  name?: string;
  active?: boolean;
  externalId?: string | null;
};

const email = (v: unknown) => text(v, 254).toLowerCase();

function nameOf(n: Record<string, unknown> | undefined, displayName: unknown) {
  if (typeof n?.formatted === 'string' && n.formatted.trim()) return text(n.formatted, 100);
  const parts = [n?.givenName, n?.familyName].filter((x) => typeof x === 'string' && x.trim());
  if (parts.length) return text(parts.join(' '), 100);
  if (typeof displayName === 'string' && displayName.trim()) return text(displayName, 100);
  return undefined;
}

/** A whole User from POST or PUT. `userName` is the person's email here. */
export function personFromBody(body: Record<string, unknown>): PersonChanges & { email: string } {
  const primary = Array.isArray(body.emails)
    ? ((body.emails as Record<string, unknown>[]).find((e) => e?.primary) ??
      (body.emails as Record<string, unknown>[])[0])
    : undefined;
  const userName = typeof body.userName === 'string' ? body.userName : undefined;
  const address = userName?.includes('@') ? userName : primary?.value;
  if (typeof address !== 'string' || !address.includes('@'))
    throw new ScimBadRequest('userName (or a primary email) must be an email address');
  return {
    email: email(address),
    name: nameOf(body.name as Record<string, unknown> | undefined, body.displayName),
    active: body.active === undefined ? true : bool(body.active),
    externalId: typeof body.externalId === 'string' ? body.externalId.slice(0, 255) : null,
  };
}

type Op = { op?: unknown; path?: unknown; value?: unknown };

function ops(body: Record<string, unknown>): Op[] {
  if (!Array.isArray(body.Operations))
    throw new ScimBadRequest('PATCH needs an Operations list', 'invalidSyntax');
  return body.Operations as Op[];
}

const opName = (o: Op) => String(o.op ?? '').toLowerCase();

/** A User PATCH, applied in order. Remove is accepted only for externalId. */
export function personPatch(body: Record<string, unknown>): PersonChanges {
  const out: PersonChanges = {};
  const name: Record<string, unknown> = {};
  const apply = (path: string, value: unknown, op: string) => {
    const p = path.toLowerCase();
    if (op === 'remove') {
      if (p === 'externalid') out.externalId = null;
      else throw new ScimBadRequest(`Can't remove ${path}`, 'noTarget');
      return;
    }
    if (p === 'active') out.active = bool(value);
    else if (p === 'username' || p.startsWith('emails'))
      out.email = email(
        Array.isArray(value) ? (value[0] as Record<string, unknown>)?.value : value,
      );
    else if (p === 'externalid') out.externalId = value === null ? null : text(value, 255);
    else if (p === 'displayname' || p === 'name.formatted') name.formatted = value;
    else if (p === 'name.givenname') name.givenName = value;
    else if (p === 'name.familyname') name.familyName = value;
    else if (p === 'name' && value && typeof value === 'object') Object.assign(name, value);
    // Anything else (title, phone numbers, enterprise extension) isn't kept here: ignore it.
  };
  for (const o of ops(body)) {
    const op = opName(o);
    if (op !== 'add' && op !== 'replace' && op !== 'remove')
      throw new ScimBadRequest(`Unknown op ${String(o.op)}`, 'invalidSyntax');
    if (typeof o.path === 'string') apply(o.path, o.value, op);
    else if (o.value && typeof o.value === 'object' && op !== 'remove')
      for (const [k, v] of Object.entries(o.value)) apply(k, v, op);
    else throw new ScimBadRequest('An op needs a path or an object value', 'invalidSyntax');
  }
  const n = nameOf(name, undefined);
  if (n) out.name = n;
  return out;
}

/** What a Group request changes: its name, and its members (by user id). */
export type GroupChanges = {
  displayName?: string;
  externalId?: string | null;
  /** Replaces every member. */
  members?: string[];
  add: string[];
  remove: string[];
};

const memberIds = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).value : m))
    .filter((x): x is string => typeof x === 'string' && !!x);

export function groupFromBody(body: Record<string, unknown>): GroupChanges & {
  displayName: string;
} {
  return {
    displayName: text(body.displayName, 200),
    externalId: typeof body.externalId === 'string' ? body.externalId.slice(0, 255) : null,
    members: memberIds(body.members),
    add: [],
    remove: [],
  };
}

/** A Group PATCH: rename, add, remove or replace members, in Okta's and Entra's shapes. */
export function groupPatch(body: Record<string, unknown>): GroupChanges {
  const out: GroupChanges = { add: [], remove: [] };
  for (const o of ops(body)) {
    const op = opName(o);
    const path = typeof o.path === 'string' ? o.path : '';
    const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
    if (filtered) {
      if (op !== 'remove') throw new ScimBadRequest(`Can't ${op} ${path}`, 'invalidSyntax');
      out.remove.push(filtered[1]!);
    } else if (path.toLowerCase() === 'members') {
      if (op === 'add') out.add.push(...memberIds(o.value));
      else if (op === 'remove') {
        // Without a value, every member goes.
        if (o.value === undefined) out.members = [];
        else out.remove.push(...memberIds(o.value));
      } else if (op === 'replace') out.members = memberIds(o.value);
      else throw new ScimBadRequest(`Unknown op ${String(o.op)}`, 'invalidSyntax');
    } else if (path.toLowerCase() === 'displayname') out.displayName = text(o.value, 200);
    else if (path.toLowerCase() === 'externalid')
      out.externalId = op === 'remove' ? null : text(o.value, 255);
    else if (!path && o.value && typeof o.value === 'object') {
      const v = o.value as Record<string, unknown>;
      if (v.displayName !== undefined) out.displayName = text(v.displayName, 200);
      if (v.members !== undefined) {
        if (op === 'add') out.add.push(...memberIds(v.members));
        else out.members = memberIds(v.members);
      }
    } else throw new ScimBadRequest('An op needs a path or an object value', 'invalidSyntax');
  }
  return out;
}

/** The highest of the roles, or null for none. */
export function highestRole(roles: Iterable<Role>): Role | null {
  let best = -1;
  for (const r of roles) best = Math.max(best, ROLES.indexOf(r));
  return best < 0 ? null : ROLES[best]!;
}

/** The group → role map as stored (`scim_roles`), with anything unreadable dropped. */
export function readRoleMap(raw: string | null | undefined): Record<string, Role> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, Role] => isRole(e[1])));
  } catch {
    return {};
  }
}

/**
 * A person's role from their groups: the highest role mapped to any of them, or viewer when none
 * of their groups is mapped.
 */
export const roleFromGroups = (groupIds: string[], map: Record<string, Role>): Role =>
  highestRole(groupIds.flatMap((g) => (map[g] ? [map[g]] : []))) ?? 'viewer';
