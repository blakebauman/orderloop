import {
  AGENT_CARD_PATH,
  agentCard,
  isLegacyA2AVersion,
  legacyAgentCard,
  runHealthChecks,
  UCP_PATH,
  UCP_PROFILE_PATH,
} from '@orderloop/core';
import { createRequestHandler } from 'react-router';
import {
  handleApi,
  handleShopifyOrder,
  handleSignedEvent,
  handleSignedOrder,
} from '../app/lib/api.server';
import {
  apiPrincipal,
  awaitingSetup,
  principal,
  sessionId,
  setupDue,
  Throttled,
  TokenExpired,
} from '../app/lib/auth.server';
import { withSecurityHeaders } from '../app/lib/csp';
import { demoRefusal } from '../app/lib/demo.server';
import { docs, engine } from '../app/lib/env.server';
import { isOAuthPath, oauthFetch } from '../app/lib/oauth.server';
import { openApiDocument } from '../app/lib/openapi';
import { crossOrigin } from '../app/lib/origin';
import { pluginFetch, pluginPathId } from '../app/lib/plugins.server';
import { setPrincipalHeader } from '../app/lib/principal.server';
import { overBudget } from '../app/lib/rate-limit';
import { SCIM_PATH } from '../app/lib/scim';
import { scimFetch } from '../app/lib/scim.server';
import { handleStripeWebhook } from '../app/lib/stripe.server';
import { ucpDiscovery, ucpFetch } from '../app/lib/ucp.server';

/**
 * The deploy smoke test's check: this Worker's D1 and R2, and the engine's (over the service
 * binding, so a broken engine deploy fails it too). 503 when anything is down.
 */
async function deepHealth(env: Env): Promise<Response> {
  const report = await runHealthChecks('orderloop-web', {
    db: () => env.DB.prepare('select 1').first(),
    docs: () => env.DOCS.head('health'),
    engine: async () => {
      const r = await engine().health();
      if (!r.ok) throw new Error('engine unhealthy');
    },
  });
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}

/** The OpenAPI document only changes with a deploy: build it once per isolate and origin. */
const openApiDocs = new Map<string, string>();

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await route(request, env, ctx), new URL(request.url));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-web' });
  if (url.pathname === '/health/deep') return deepHealth(env);

  // With no people yet, a deployed workspace is waiting for its first admin: only the setup page
  // (and its assets) answer. On localhost the same state is open, for local development.
  if (
    url.pathname !== '/setup' &&
    !url.pathname.startsWith('/assets/') &&
    (await awaitingSetup(url))
  )
    return request.method === 'GET' && request.headers.get('accept')?.includes('text/html')
      ? Response.redirect(new URL('/setup', url).href, 302)
      : Response.json({ error: 'This workspace is not set up yet.' }, { status: 503 });

  // A demo deployment keeps visitors away from people, credentials and outbound endpoints.
  const locked = demoRefusal(request);
  if (locked) return locked;

  // A2A discovery: the Agent Card is public, like the OpenAPI document. A 1.0 client says so
  // (A2A-Version: 1.0); anyone else gets the 0.3 shape, which embeds the 1.0 interfaces.
  if (url.pathname === AGENT_CARD_PATH && request.method === 'GET') {
    const legacy = isLegacyA2AVersion(request.headers.get('a2a-version'));
    return Response.json(legacy ? legacyAgentCard(url.origin) : agentCard(url.origin), {
      headers: { 'cache-control': 'public, max-age=300', vary: 'A2A-Version' },
    });
  }

  // UCP (agentic checkout): the business profile is public; checkout and orders under /ucp take
  // a registered platform's key (app/lib/ucp.server.ts).
  if (url.pathname === UCP_PROFILE_PATH && request.method === 'GET') return ucpDiscovery(url);
  if (url.pathname === UCP_PATH || url.pathname.startsWith(`${UCP_PATH}/`))
    return ucpFetch(request);

  // MCP, A2A and their OAuth endpoints (discovery, registration, tokens). The consent page
  // itself, /oauth/authorize, is a page of the app below.
  if (isOAuthPath(url.pathname)) return oauthFetch(request, env, ctx);

  // SCIM provisioning from the identity provider, with its own bearer token.
  if (url.pathname === SCIM_PATH || url.pathname.startsWith(`${SCIM_PATH}/`))
    return scimFetch(request);

  // Signed webhooks authenticate by HMAC, not by the admin password.
  if (url.pathname === '/api/v1/webhooks/events' && request.method === 'POST') {
    return handleSignedEvent(request);
  }
  if (url.pathname === '/api/v1/webhooks/orders' && request.method === 'POST') {
    return handleSignedOrder(request);
  }
  // Stripe signs with the endpoint's signing secret (Stripe-Signature).
  if (url.pathname === '/api/v1/webhooks/stripe' && request.method === 'POST') {
    return handleStripeWebhook(request);
  }
  // Shopify signs with its own HMAC header, not a bearer token.
  if (url.pathname === '/api/v1/channels/shopify/orders' && request.method === 'POST') {
    return handleShopifyOrder(request);
  }

  // A browser's state-changing requests and the order page's socket must come from this origin;
  // bearer-token calls carry no ambient cookie, so they're exempt.
  const bearer = /^Bearer\s/i.test(request.headers.get('authorization') ?? '');
  if (!bearer && crossOrigin(request, url.origin))
    return Response.json({ error: 'Cross-site request refused' }, { status: 403 });

  // The API description is public, like any published spec.
  if (url.pathname === '/api/v1/openapi.json' && request.method === 'GET') {
    let doc = openApiDocs.get(url.origin);
    if (!doc) {
      doc = JSON.stringify(openApiDocument(url.origin));
      openApiDocs.set(url.origin, doc);
    }
    return new Response(doc, {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  }

  if (url.pathname.startsWith('/api/v1/')) {
    let caller: Awaited<ReturnType<typeof apiPrincipal>>;
    try {
      caller = await apiPrincipal(request);
    } catch (err) {
      if (err instanceof TokenExpired)
        return Response.json({ error: err.message }, { status: 401 });
      if (!(err instanceof Throttled)) throw err;
      return Response.json(
        { error: err.message },
        { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
      );
    }
    if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const due = setupDue(caller);
    if (due) return Response.json({ error: due }, { status: 403 });
    const limited = await overBudget('API_LIMIT', caller.id);
    if (limited) return limited;
    return handleApi(request, caller);
  }

  // The order page's live connection to its OrderAgent, and the assistant panel's to the
  // person's own AssistantAgent (Agents SDK WebSocket + RPC, and the chat's message fetch).
  const order = url.pathname.startsWith('/agents/order-agent/');
  const assistant = url.pathname.startsWith('/agents/assistant-agent/');
  if (order || assistant) {
    const caller = await principal(request);
    if (!caller) return new Response('Unauthorized', { status: 401 });
    const due = setupDue(caller);
    if (due) return new Response(due, { status: 403 });
    // The agent checks each call against this; whatever the browser sent is replaced. A
    // person's session id lets it notice a sign-out, a disable or a role change mid-page.
    // Credentials stay here: the engine trusts the principal header alone.
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    const session = caller.kind === 'user' ? await sessionId(request) : undefined;
    // Everyone has exactly one assistant, named after them: whatever name the browser asked
    // for, it reaches its own.
    const path = assistant
      ? url.pathname.replace(
          /^\/agents\/assistant-agent\/[^/]*/,
          `/agents/assistant-agent/${encodeURIComponent(caller.id)}`,
        )
      : url.pathname;
    await setPrincipalHeader(headers, { ...caller, ...(session ? { session } : {}) }, path);
    return engine().fetch(
      new Request(`https://engine${path}${url.search}`, new Request(request, { headers })),
    );
  }

  // Installed plugins' pages, on their own Workers (app/lib/plugins.server.ts).
  if (pluginPathId(url.pathname)) return pluginFetch(request);

  // Order documents (invoices, POs, inbound POs) from R2.
  if (url.pathname.startsWith('/docs/orders/')) {
    const caller = await principal(request);
    if (!caller) return new Response('Unauthorized', { status: 401 });
    const due = setupDue(caller);
    if (due) return new Response(due, { status: 403 });
    // A browser that has the document asks with its ETag; R2 then skips the body.
    const ifNoneMatch = request.headers.get('if-none-match');
    const obj = await docs().get(
      decodeURIComponent(url.pathname.slice('/docs/'.length)),
      ifNoneMatch ? { onlyIf: new Headers({ 'if-none-match': ifNoneMatch }) } : undefined,
    );
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      etag: obj.httpEtag,
      // Only this browser may keep it (it took a sign-in), and only briefly without asking.
      'cache-control': 'private, max-age=300',
    };
    if (!('body' in obj)) return new Response(null, { status: 304, headers });
    return new Response(obj.body, { headers });
  }

  const res = await requestHandler(request);
  // Pages are per person and change as orders move: a browser may keep one, but asks first.
  if (res.headers.get('content-type')?.startsWith('text/html') && !res.headers.has('cache-control'))
    res.headers.set('cache-control', 'private, no-cache');
  return res;
}
