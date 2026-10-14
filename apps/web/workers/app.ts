import {
  AGENT_CARD_PATH,
  agentCard,
  encodePrincipal,
  isLegacyA2AVersion,
  legacyAgentCard,
  PRINCIPAL_HEADER,
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
  principal,
  sessionId,
  Throttled,
  TokenExpired,
  TWO_FACTOR_DUE,
} from '../app/lib/auth.server';
import { docs, engine } from '../app/lib/env.server';
import { isOAuthPath, oauthFetch } from '../app/lib/oauth.server';
import { openApiDocument } from '../app/lib/openapi';
import { crossOrigin } from '../app/lib/origin';

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-web' });

    // A2A discovery: the Agent Card is public, like the OpenAPI document. A 1.0 client says so
    // (A2A-Version: 1.0); anyone else gets the 0.3 shape, which embeds the 1.0 interfaces.
    if (url.pathname === AGENT_CARD_PATH && request.method === 'GET') {
      const legacy = isLegacyA2AVersion(request.headers.get('a2a-version'));
      return Response.json(legacy ? legacyAgentCard(url.origin) : agentCard(url.origin), {
        headers: { 'cache-control': 'public, max-age=300', vary: 'A2A-Version' },
      });
    }

    // MCP, A2A and their OAuth endpoints (discovery, registration, tokens). The consent page
    // itself, /oauth/authorize, is a page of the app below.
    if (isOAuthPath(url.pathname)) return oauthFetch(request, env, ctx);

    // Signed webhooks authenticate by HMAC, not by the admin password.
    if (url.pathname === '/api/v1/webhooks/events' && request.method === 'POST') {
      return handleSignedEvent(request);
    }
    if (url.pathname === '/api/v1/webhooks/orders' && request.method === 'POST') {
      return handleSignedOrder(request);
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
      return Response.json(openApiDocument(url.origin));
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
      if (caller.twoFactorDue) return Response.json({ error: TWO_FACTOR_DUE }, { status: 403 });
      return handleApi(request, caller);
    }

    // The order page's live connection to its OrderAgent, and the assistant panel's to the
    // person's own AssistantAgent (Agents SDK WebSocket + RPC, and the chat's message fetch).
    const order = url.pathname.startsWith('/agents/order-agent/');
    const assistant = url.pathname.startsWith('/agents/assistant-agent/');
    if (order || assistant) {
      const caller = await principal(request);
      if (!caller) return new Response('Unauthorized', { status: 401 });
      if (caller.twoFactorDue) return new Response(TWO_FACTOR_DUE, { status: 403 });
      // The agent checks each call against this; whatever the browser sent is replaced. A
      // person's session id lets it notice a sign-out, a disable or a role change mid-page.
      const headers = new Headers(request.headers);
      const session = caller.kind === 'user' ? await sessionId(request) : undefined;
      headers.set(
        PRINCIPAL_HEADER,
        encodePrincipal({ ...caller, ...(session ? { session } : {}) }),
      );
      // Everyone has exactly one assistant, named after them: whatever name the browser asked
      // for, it reaches its own.
      const path = assistant
        ? url.pathname.replace(
            /^\/agents\/assistant-agent\/[^/]*/,
            `/agents/assistant-agent/${encodeURIComponent(caller.id)}`,
          )
        : url.pathname;
      return engine().fetch(
        new Request(`https://engine${path}${url.search}`, new Request(request, { headers })),
      );
    }

    // Order documents (invoices, POs, inbound POs) from R2.
    if (url.pathname.startsWith('/docs/orders/')) {
      const caller = await principal(request);
      if (!caller) return new Response('Unauthorized', { status: 401 });
      if (caller.twoFactorDue) return new Response(TWO_FACTOR_DUE, { status: 403 });
      const obj = await docs().get(decodeURIComponent(url.pathname.slice('/docs/'.length)));
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    }

    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
