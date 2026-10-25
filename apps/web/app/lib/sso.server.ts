/**
 * Single sign-on with the workspace's OpenID Connect identity provider (Okta, Entra ID, Google
 * Workspace, …): the authorization code flow with PKCE, a state and a nonce.
 *
 * The provider is set per deployment: `OIDC_ISSUER` and `OIDC_CLIENT_ID` (vars, from the
 * registry's `sso`) and the `OIDC_CLIENT_SECRET` secret. Admins choose the rest on the Team page
 * (`ssoSettings`). `/login/sso` starts a sign-in and keeps its state, nonce and code verifier in a
 * short-lived `__Host-ol_sso` cookie, sealed with `PRINCIPAL_KEY` (`signSsoFlow`) so the browser
 * can't change it or bring it back after it expires; `/login/sso/callback` checks the state, swaps the code for
 * an ID token, verifies it against the provider's keys and starts the same session a password
 * would (`startSession`). Who the identity signs in as is `decideSso` (`sso.ts`). Linking an
 * identity to someone who has a password waits for that password (and their two-factor code) at
 * `/login/sso/link`: the provider vouching for an email doesn't hand over an account on its own.
 *
 * A step-up (`stepUp`) for someone who has only single sign-on starts the same flow with `reauth`:
 * the request asks the provider to sign them in again (`prompt=login`, `max_age=0`), and the
 * callback takes its answer only if the ID token's `auth_time` is after the flow began and within
 * the flow's own lifetime of now, so a provider that answers from its own session fails closed.
 */

import { env } from 'cloudflare:workers';
import {
  newId,
  type Principal,
  type Role,
  SSO_LINK_TTL_MS,
  signSsoFlow,
  signSsoLink,
  verifySsoFlow,
  verifySsoLink,
} from '@orderloop/core';
import { users } from '@orderloop/db';
import { and, eq, isNull } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { audit } from './audit.server';
import { type Caller, cookie, forgetUserCount, startSession } from './auth.server';
import { normalizeEmail, randomToken } from './credentials';
import { db } from './env.server';
import { principalKey } from './principal.server';
import { ssoOnlyInEffect, ssoSettings } from './settings.server';
import { decideSso, type SsoIdentity } from './sso';

const COOKIE = '__Host-ol_sso';
const FLOW_MS = 10 * 60_000;
const FETCH_MS = 10_000;
const DISCOVERY_MS = 60 * 60_000;

export const CALLBACK_PATH = '/login/sso/callback';
export const LINK_PATH = '/login/sso/link';
const LINK_COOKIE = '__Host-ol_sso_link';

export type SsoConfig = { issuer: string; clientId: string; clientSecret: string };

/** The deployment's identity provider, or null when SSO isn't set up. */
export function ssoConfig(): SsoConfig | null {
  const e = env as { OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string; OIDC_CLIENT_SECRET?: string };
  if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID || !e.OIDC_CLIENT_SECRET) return null;
  return {
    issuer: e.OIDC_ISSUER.replace(/\/+$/, ''),
    clientId: e.OIDC_CLIENT_ID,
    clientSecret: e.OIDC_CLIENT_SECRET,
  };
}

/** Why SSO didn't sign someone in. `code` picks what the sign-in page says. */
export class SsoError extends Error {
  constructor(
    readonly reason: string,
    readonly code: 'failed' | 'refused' | 'disabled' = 'failed',
  ) {
    super(reason);
  }
}

// ── Provider metadata ──

type Metadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
};

let discovered: { issuer: string; at: number; value: Metadata } | null = null;
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function metadata(c: SsoConfig): Promise<Metadata> {
  if (discovered?.issuer === c.issuer && Date.now() - discovered.at < DISCOVERY_MS)
    return discovered.value;
  const res = await fetch(`${c.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new SsoError(`discovery returned HTTP ${res.status}`);
  const m = (await res.json()) as Partial<Metadata>;
  // The document must speak for the issuer it was fetched from.
  if (m.issuer?.replace(/\/+$/, '') !== c.issuer) throw new SsoError('discovery issuer mismatch');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
    if (typeof m[k] !== 'string' || !m[k].startsWith('https://'))
      throw new SsoError(`discovery has no https ${k}`);
  discovered = { issuer: c.issuer, at: Date.now(), value: m as Metadata };
  return discovered.value;
}

function keySet(uri: string) {
  let set = keySets.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri), { timeoutDuration: FETCH_MS });
    keySets.set(uri, set);
  }
  return set;
}

// ── Starting ──

type Flow = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  /** A step-up: the provider was asked to sign them in again, from `at`. */
  reauth?: { at: number };
};

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * The provider's sign-in URL for this request, and the cookie that ties its answer to it. With
 * `reauth`, it asks the provider to sign them in again, whatever session it already has.
 */
export async function startSso(request: Request, c: SsoConfig, next: string, reauth = false) {
  const m = await metadata(c);
  const flow: Flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), next };
  if (reauth) flow.reauth = { at: Date.now() };
  const challenge = b64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier)),
  );
  const url = new URL(m.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: new URL(CALLBACK_PATH, request.url).href,
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(reauth ? { prompt: 'login', max_age: '0' } : {}),
  }).toString();
  const value = await signSsoFlow(principalKey(), flow, Date.now() + FLOW_MS);
  return {
    location: url.href,
    // Lax: the provider's redirect back is a top-level GET, which carries it.
    cookie: `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_MS / 1000}`,
  };
}

export const clearSsoCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// ── Finishing ──

async function readFlow(request: Request): Promise<Flow | null> {
  const f = (await verifySsoFlow(
    [principalKey(), (env as { PRINCIPAL_KEY_PREVIOUS?: string }).PRINCIPAL_KEY_PREVIOUS],
    cookie(request, COOKIE),
  )) as Partial<Flow> | null;
  if (!f) return null;
  return typeof f.state === 'string' &&
    typeof f.nonce === 'string' &&
    typeof f.verifier === 'string' &&
    typeof f.next === 'string' &&
    (f.reauth === undefined || typeof f.reauth?.at === 'number')
    ? (f as Flow)
    : null;
}

/**
 * Checks the provider's answer and returns who it vouches for, and where they were going: the
 * state matches this browser's flow, the code swaps for an ID token, and the token is signed by
 * the provider, for this client, with this flow's nonce and not expired. For a step-up, they
 * must also have signed in at the provider after the flow began (`auth_time`); `reauthAt` is when.
 */
export async function verifyCallback(
  request: Request,
  c: SsoConfig,
): Promise<{ identity: SsoIdentity; next: string; reauthAt: number | null }> {
  const url = new URL(request.url);
  const flow = await readFlow(request);
  if (!flow) throw new SsoError('no sign-in in progress (expired or another browser)');
  const error = url.searchParams.get('error');
  if (error) throw new SsoError(`provider answered ${error.slice(0, 60)}`);
  if (url.searchParams.get('state') !== flow.state) throw new SsoError('state mismatch');
  const code = url.searchParams.get('code');
  if (!code) throw new SsoError('no code');

  const m = await metadata(c);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: new URL(CALLBACK_PATH, request.url).href,
    code_verifier: flow.verifier,
    client_id: c.clientId,
  });
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  });
  const methods = m.token_endpoint_auth_methods_supported;
  if (!methods || methods.includes('client_secret_basic'))
    headers.set(
      'authorization',
      `Basic ${btoa(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`)}`,
    );
  else body.set('client_secret', c.clientSecret);
  const res = await fetch(m.token_endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new SsoError(`token endpoint returned HTTP ${res.status}`);
  const { id_token } = (await res.json()) as { id_token?: unknown };
  if (typeof id_token !== 'string') throw new SsoError('no ID token');

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(id_token, keySet(m.jwks_uri), {
      issuer: m.issuer,
      audience: c.clientId,
      clockTolerance: 60,
    }));
  } catch (err) {
    throw new SsoError(`ID token: ${err instanceof Error ? err.message : 'invalid'}`);
  }
  if (claims.nonce !== flow.nonce) throw new SsoError('nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new SsoError('no subject');
  let reauthAt: number | null = null;
  if (flow.reauth) {
    // The same minute of clock skew the token's own times get, and never older than a flow lives.
    const at = typeof claims.auth_time === 'number' ? claims.auth_time * 1000 : 0;
    const since = Math.max(flow.reauth.at, Date.now() - FLOW_MS) - 60_000;
    if (at < since) throw new SsoError('provider did not sign them in again');
    reauthAt = Date.now();
  }
  // An email the provider says it hasn't verified can't match or create anyone. Entra ID leaves
  // the claim out; its addresses belong to the tenant.
  const email =
    typeof claims.email === 'string' && claims.email_verified !== false
      ? normalizeEmail(claims.email)
      : null;
  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 100) : null;
  return {
    identity: { sub: claims.sub.slice(0, 255), email: email || null, name },
    next: flow.next,
    reauthAt,
  };
}

/**
 * Signs in whoever the identity is (linking or adding them as `decideSso` says): the session
 * cookie. Or, when the link is to someone with a password, the cookie that keeps it waiting for
 * that password (`LINK_PATH`).
 */
export async function signInWithSso(
  request: Request,
  identity: SsoIdentity,
): Promise<{ session: string } | { confirmLink: string }> {
  const select = {
    id: users.id,
    email: users.email,
    name: users.name,
    role: users.role,
    externalSub: users.externalSub,
    disabledAt: users.disabledAt,
    passwordHash: users.passwordHash,
  };
  const bySub = await db()
    .select(select)
    .from(users)
    .where(eq(users.externalSub, identity.sub))
    .get();
  const byEmail =
    !bySub && identity.email
      ? await db().select(select).from(users).where(eq(users.email, identity.email)).get()
      : undefined;
  const decision = decideSso(identity, bySub, byEmail, await ssoSettings());
  const target = identity.email ?? identity.sub;
  if (decision.kind === 'refuse')
    throw new SsoError(decision.reason, decision.reason === 'disabled' ? 'disabled' : 'refused');

  let person: Principal;
  if (decision.kind === 'create') {
    const id = newId('usr');
    const role: Role = decision.role;
    const name = identity.name || decision.email.split('@')[0]!;
    await db().insert(users).values({
      id,
      email: decision.email,
      name,
      role,
      externalSub: identity.sub,
      createdAt: Date.now(),
    });
    forgetUserCount();
    person = { kind: 'user', id, email: decision.email, name, role };
    await audit(request, 'team.user_added', {
      actor: person,
      target: decision.email,
      detail: { role, via: 'sso' },
    });
  } else {
    const row = (decision.kind === 'existing' ? bySub : byEmail)!;
    if (decision.kind === 'link' && row.passwordHash)
      return { confirmLink: await linkCookie({ userId: row.id, sub: identity.sub }) };
    if (decision.kind === 'link') {
      await db().update(users).set({ externalSub: identity.sub }).where(eq(users.id, row.id));
      await audit(request, 'auth.sso_linked', {
        actor: {
          kind: 'user',
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role as Role,
        },
        target,
      });
    }
    person = { kind: 'user', id: row.id, email: row.email, name: row.name, role: row.role as Role };
  }
  await audit(request, 'auth.sign_in', { actor: person, detail: { method: 'sso' } });
  return { session: await startSession(request, person.id) };
}

// ── Linking someone with a password ──

async function linkCookie(link: { userId: string; sub: string }) {
  const value = await signSsoLink(principalKey(), link);
  // Lax: it is set at the end of the provider's cross-site redirect and read on the next page.
  return `${LINK_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SSO_LINK_TTL_MS / 1000}`;
}

export const clearLinkCookie = `${LINK_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/**
 * The link this browser is waiting to confirm, and the person it is for, or null: none, expired,
 * or the person was disabled, lost their password or was linked meanwhile.
 */
export async function pendingSsoLink(request: Request) {
  const link = await verifySsoLink(
    [principalKey(), (env as { PRINCIPAL_KEY_PREVIOUS?: string }).PRINCIPAL_KEY_PREVIOUS],
    cookie(request, LINK_COOKIE),
  );
  if (!link) return null;
  const user = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      passwordHash: users.passwordHash,
      totpEnabledAt: users.totpEnabledAt,
      externalSub: users.externalSub,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(eq(users.id, link.userId))
    .get();
  if (!user?.passwordHash || user.disabledAt || user.externalSub) return null;
  return { sub: link.sub, user: { ...user, passwordHash: user.passwordHash } };
}

/**
 * Links the waiting identity once its person has signed in with their password (and code). False
 * when the signed-in person isn't the one the link is for, or the identity went to someone else.
 */
export async function finishSsoLink(
  request: Request,
  caller: Pick<Caller, 'kind' | 'id' | 'name' | 'email' | 'role'>,
): Promise<boolean> {
  const pending = await pendingSsoLink(request);
  if (!pending || pending.user.id !== caller.id) return false;
  const taken = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.externalSub, pending.sub))
    .get();
  if (taken) return false;
  let linked: { id: string }[];
  try {
    linked = await db()
      .update(users)
      .set({ externalSub: pending.sub })
      .where(and(eq(users.id, caller.id), isNull(users.externalSub)))
      .returning({ id: users.id });
  } catch {
    // Someone else took the subject between the check and the write (its unique index).
    return false;
  }
  if (!linked.length) return false;
  await audit(request, 'auth.sso_linked', {
    actor: caller,
    target: pending.user.email,
    detail: { confirmed: 'password' },
  });
  return true;
}

/** Whether this person has signed in with single sign-on at least once (and so is linked). */
export async function linkedToSso(userId: string): Promise<boolean> {
  const row = await db()
    .select({ sub: users.externalSub })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return !!row?.sub;
}

/**
 * Whether this person signs in with a password here, and so manages it, two-factor sign-in and
 * passkeys on their Account page: not someone single sign-on added (no password), nor anyone
 * while the workspace is SSO-only.
 */
export async function usesPassword(userId: string): Promise<boolean> {
  if (await ssoOnlyInEffect()) return false;
  const row = await db()
    .select({ hash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return !!row?.hash;
}
