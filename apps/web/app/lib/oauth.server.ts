/**
 * MCP (`/mcp`) and A2A (`/a2a`) on the public origin. @cloudflare/workers-oauth-provider is the
 * authorization server for both: discovery (`/.well-known/oauth-authorization-server`), client
 * registration (`/oauth/register`, or a Client ID Metadata Document), tokens (`/oauth/token`) and
 * grants in `OAUTH_KV`. Each endpoint is its own protected resource, so a token is issued for one
 * of them (RFC 8707) and publishes its metadata at `/.well-known/oauth-protected-resource/<path>`.
 * The consent page is ours (routes/oauth-authorize.tsx): a signed-in person approves a client with
 * a role no higher than their own, and can disconnect it from their Account page.
 *
 * Both endpoints also take the REST API's credentials as a bearer token (`ol_live_…` API tokens),
 * so clients configured with a header (Claude Code, Cursor, an A2A
 * client) work without the browser flow. Either way the caller is resolved here, as they are now,
 * and the request is forwarded to the engine (apps/engine/src/mcp.ts, apps/engine/src/a2a/) with
 * the principal header, like the agent sockets.
 */

import { env } from 'cloudflare:workers';
import {
  OAuthAuthorizationServer,
  OAuthError,
  type OAuthHelpers,
  OAuthResourceServer,
} from '@cloudflare/workers-oauth-provider';
import { A2A_PATH, type Principal, ROLES, type Role } from '@orderloop/core';
import { clientIp } from './audit.server';
import {
  apiPrincipal,
  type Caller,
  type GrantProps,
  grantPrincipal,
  setupDue,
  Throttled,
  TokenExpired,
} from './auth.server';
import { engine } from './env.server';
import { setPrincipalHeader } from './principal.server';
import { overBudget } from './rate-limit';

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';

/**
 * The roles an app can be granted: a grant's scope is one of them. Admin is never offered (the
 * consent page lists these), so a connected app never acts as an admin.
 */
export const GRANTABLE_ROLES = ROLES.filter((r) => r !== 'admin') as Exclude<Role, 'admin'>[];

/** The protected endpoints, each its own OAuth resource. */
const ENDPOINTS = { [MCP_PATH]: 'OrderLoop MCP', [A2A_PATH]: 'OrderLoop A2A' } as const;
type Endpoint = keyof typeof ENDPOINTS;
const isEndpoint = (pathname: string): pathname is Endpoint => pathname in ENDPOINTS;

/** What an endpoint hands the forwarder: a caller resolved from an API token, or an OAuth grant. */
type Props = { principal: Caller } | GrantProps;

const resource = (origin: string, path: Endpoint) => `${origin}${path}`;

/** Paths the OAuth roles answer; everything else goes straight to the app. */
export const isOAuthPath = (pathname: string) =>
  isEndpoint(pathname) ||
  pathname.startsWith('/.well-known/oauth-') ||
  (pathname.startsWith('/oauth/') && pathname !== AUTHORIZE_PATH);

/** The channel an authorization request is for, as the audit trail names it. */
export const channelOf = (resourceUrl: string | undefined) =>
  resourceUrl && new URL(resourceUrl).pathname === A2A_PATH ? 'A2A' : 'MCP';

function authorizationServer(origin: string) {
  return new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: Object.keys(ENDPOINTS).map((p) => resource(origin, p as Endpoint)),
    // MCP connected before A2A existed: grants from then, and clients that name no resource, are
    // for MCP. A2A clients name theirs.
    defaultResource: resource(origin, MCP_PATH),
    legacyGrantResource: resource(origin, MCP_PATH),
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    // A grant's scope is the role the person granted.
    scopesSupported: [...ROLES],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86_400,
    clientIdMetadataDocumentEnabled: true,
  });
}

/** Tokens this authorization server issued look like `<user>:<grant>:<secret>`. */
const issuedToken = (token: string) => token.split(':').length === 3;

function resourceServer(origin: string, as: OAuthAuthorizationServer<Env>, path: Endpoint) {
  return new OAuthResourceServer<Env, Props>({
    resourceMetadata: {
      resource: resource(origin, path),
      authorization_servers: [origin],
      resource_name: ENDPOINTS[path],
      // Also named in the 401 challenge's `scope`, so a client knows what to ask for.
      scopes_supported: GRANTABLE_ROLES,
    },
    validateToken: (env, request) => async (res, token) => {
      if (issuedToken(token)) return as.validateToken<Props>(res, token, env);
      let caller: Caller | null;
      try {
        caller = await apiPrincipal(request);
      } catch (err) {
        if (err instanceof TokenExpired)
          throw new OAuthError('invalid_token', { description: err.message, statusCode: 401 });
        if (!(err instanceof Throttled)) throw err;
        throw new OAuthError('temporarily_unavailable', {
          description: err.message,
          statusCode: 429,
          headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) },
        });
      }
      return caller ? { props: { principal: caller }, audience: res } : null;
    },
    handler: { fetch: (request, _env, ctx) => forward(request, path, ctx.props) },
  });
}

type Roles = {
  as: OAuthAuthorizationServer<Env>;
  endpoints: Record<Endpoint, OAuthResourceServer<Env, Props>>;
};

// One set per origin (orderloop.app, or localhost in development), made once per isolate.
const roles = new Map<string, Roles>();

function rolesFor(origin: string): Roles {
  let r = roles.get(origin);
  if (!r) {
    const as = authorizationServer(origin);
    r = {
      as,
      endpoints: {
        [MCP_PATH]: resourceServer(origin, as, MCP_PATH),
        [A2A_PATH]: resourceServer(origin, as, A2A_PATH),
      },
    };
    roles.set(origin, r);
  }
  return r;
}

const PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource';

/**
 * Serves an OAuth path (see `isOAuthPath`): an endpoint or its resource metadata goes to that
 * resource server, everything else (discovery, registration, tokens) to the authorization server.
 */
export async function oauthFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  // Registration and tokens are open to anyone on the internet: limit each address.
  const limiter =
    url.pathname === '/oauth/register'
      ? env.OAUTH_REGISTER_LIMIT
      : url.pathname === '/oauth/token'
        ? env.OAUTH_TOKEN_LIMIT
        : undefined;
  if (limiter && !(await limiter.limit({ key: clientIp(request) })).success)
    return Response.json(
      { error: 'slow_down', error_description: 'Too many requests; try again in a minute.' },
      { status: 429, headers: { 'retry-after': '60' } },
    );
  const { as, endpoints } = rolesFor(url.origin);
  const path = url.pathname.startsWith(`${PROTECTED_RESOURCE}/`)
    ? url.pathname.slice(PROTECTED_RESOURCE.length)
    : url.pathname;
  if (isEndpoint(path)) return endpoints[path].fetch(request, env, ctx);
  return as.fetch(request, env, ctx);
}

/** The authorization server's helpers, for the consent page and the Account page. */
export function oauthApi(request: Request): OAuthHelpers {
  return rolesFor(new URL(request.url).origin).as.getOAuthApi(env);
}

/** A browser Origin, when there is one, must at least be a real web origin. */
function badOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol !== 'https:' && u.protocol !== 'http:';
  } catch {
    return true;
  }
}

async function forward(request: Request, path: Endpoint, props: Props): Promise<Response> {
  if (badOrigin(request)) return Response.json({ error: 'Origin refused' }, { status: 403 });
  const caller = 'principal' in props ? props.principal : await grantPrincipal(props);
  if (!caller)
    return Response.json(
      { error: 'This connection has ended. Connect the app again.' },
      { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } },
    );
  const due = setupDue(caller);
  if (due) return Response.json({ error: due }, { status: 403 });
  // MCP and A2A have a budget each, per principal.
  const limited = await overBudget('AGENT_LIMIT', `${path}:${caller.id}`);
  if (limited) return limited;
  const { twoFactorDue: _due, passwordChangeDue: _pw, ...principal } = caller;
  const headers = new Headers(request.headers);
  // The engine trusts the principal header; the client's credential stays here.
  headers.delete('authorization');
  headers.delete('cookie');
  await setPrincipalHeader(headers, principal satisfies Principal, path);
  return engine().fetch(new Request(`https://engine${path}`, new Request(request, { headers })));
}
