import { encodePrincipal, PRINCIPAL_HEADER } from '@orderloop/core';
import { createRequestHandler } from 'react-router';
import { handleApi, handleSignedEvent } from '../app/lib/api.server';
import { apiPrincipal, principal, Throttled } from '../app/lib/auth.server';
import { docs, engine } from '../app/lib/env.server';
import { openApiDocument } from '../app/lib/openapi';

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-web' });

    // Signed webhooks authenticate by HMAC, not by the admin password.
    if (url.pathname === '/api/v1/webhooks/events' && request.method === 'POST') {
      return handleSignedEvent(request);
    }

    // The API description is public, like any published spec.
    if (url.pathname === '/api/v1/openapi.json' && request.method === 'GET') {
      return Response.json(openApiDocument(url.origin));
    }

    if (url.pathname.startsWith('/api/v1/')) {
      let caller: Awaited<ReturnType<typeof apiPrincipal>>;
      try {
        caller = await apiPrincipal(request);
      } catch (err) {
        if (!(err instanceof Throttled)) throw err;
        return Response.json(
          { error: err.message },
          { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
        );
      }
      if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      return handleApi(request, caller);
    }

    // The order page's live connection to its OrderAgent (Agents SDK WebSocket + RPC).
    if (url.pathname.startsWith('/agents/order-agent/')) {
      const caller = await principal(request);
      if (!caller) return new Response('Unauthorized', { status: 401 });
      // The agent checks each call against this; whatever the browser sent is replaced.
      const headers = new Headers(request.headers);
      headers.set(PRINCIPAL_HEADER, encodePrincipal(caller));
      return engine().fetch(
        new Request(
          `https://engine${url.pathname}${url.search}`,
          new Request(request, { headers }),
        ),
      );
    }

    // Order documents (invoices, POs, inbound POs) from R2.
    if (url.pathname.startsWith('/docs/orders/')) {
      if (!(await principal(request))) return new Response('Unauthorized', { status: 401 });
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
