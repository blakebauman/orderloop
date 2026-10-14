/**
 * MCP on the public origin (`/mcp`). @cloudflare/workers-oauth-provider is the authorization
 * server for MCP clients: discovery (`/.well-known/oauth-*`), client registration
 * (`/oauth/register`, or a Client ID Metadata Document), tokens (`/oauth/token`) and grants in
 * `OAUTH_KV`. The consent page is ours (routes/oauth-authorize.tsx): a signed-in person approves a
 * client with a role no higher than their own, and can disconnect it from their Account page.
 *
 * `/mcp` also takes the REST API's credentials as a bearer token (`ol_live_…` API tokens, or the
 * shared APP_PASSWORD), so clients configured with a header (Claude Code, Cursor) work without
 * the browser flow. Either way the caller is resolved here, as they are now, and the request is
 * forwarded to the engine (apps/engine/src/mcp.ts) with the principal header, like the agent
 * sockets.
 */

import { env } from 'cloudflare:workers';
import {
  ExternalTokenError,
  getOAuthApi,
  type OAuthHelpers,
  OAuthProvider,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider';
import { encodePrincipal, PRINCIPAL_HEADER, type Principal, ROLES } from '@orderloop/core';
import {
  apiPrincipal,
  type Caller,
  type GrantProps,
  grantPrincipal,
  Throttled,
  TokenExpired,
  TWO_FACTOR_DUE,
} from './auth.server';
import { engine } from './env.server';

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';

/** What `/mcp` hands the forwarder: a caller resolved from an API token, or an OAuth grant. */
type McpProps = { principal: Caller } | GrantProps;

const resource = (origin: string) => `${origin}${MCP_PATH}`;

/** Paths the OAuth provider answers; everything else goes straight to the app. */
export const isOAuthPath = (pathname: string) =>
  pathname === MCP_PATH ||
  pathname.startsWith('/.well-known/oauth-') ||
  (pathname.startsWith('/oauth/') && pathname !== AUTHORIZE_PATH);

function options(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_PATH,
    apiHandler: { fetch: (request, _env, ctx) => forward(request, ctx.props as McpProps) },
    // Never reached: only OAuth paths are sent to the provider (workers/app.ts), and the consent
    // page is a route of the app.
    defaultHandler: { fetch: () => new Response('Not found', { status: 404 }) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    // A grant's scope is the role the person granted.
    scopesSupported: [...ROLES],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86_400,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: resource(origin), resource_name: 'OrderLoop' },
    resolveExternalToken: async ({ request }) => {
      let caller: Caller | null;
      try {
        caller = await apiPrincipal(request);
      } catch (err) {
        if (err instanceof TokenExpired)
          throw new ExternalTokenError('invalid_token', {
            description: err.message,
            statusCode: 401,
          });
        if (!(err instanceof Throttled)) throw err;
        throw new ExternalTokenError('temporarily_unavailable', {
          description: err.message,
          statusCode: 429,
          headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) },
        });
      }
      return caller ? { props: { principal: caller }, audience: resource(origin) } : null;
    },
  };
}

// One provider per origin (orderloop.io, or localhost in development), made once per isolate.
const providers = new Map<string, OAuthProvider<Env>>();

export function oauthProvider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider(options(origin));
    providers.set(origin, p);
  }
  return p;
}

/** The provider's helpers, for the consent page and the Account page. */
export function oauthApi(request: Request): OAuthHelpers {
  return getOAuthApi(options(new URL(request.url).origin), env);
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

async function forward(request: Request, props: McpProps): Promise<Response> {
  if (badOrigin(request)) return Response.json({ error: 'Origin refused' }, { status: 403 });
  const caller = 'principal' in props ? props.principal : await grantPrincipal(props);
  if (!caller)
    return Response.json(
      { error: 'This connection has ended. Connect the app again.' },
      { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } },
    );
  if (caller.twoFactorDue) return Response.json({ error: TWO_FACTOR_DUE }, { status: 403 });
  const { twoFactorDue: _due, ...principal } = caller;
  const headers = new Headers(request.headers);
  // The engine trusts the principal header; the client's credential stays here.
  headers.delete('authorization');
  headers.delete('cookie');
  headers.set(PRINCIPAL_HEADER, encodePrincipal(principal satisfies Principal));
  return engine().fetch(
    new Request(`https://engine${MCP_PATH}`, new Request(request, { headers })),
  );
}
