import { createRequestHandler } from 'react-router';
import { handleApi } from '../app/lib/api.server';
import { isApiAuthorized, isSignedIn } from '../app/lib/auth.server';
import { docs, engine } from '../app/lib/env.server';

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-web' });

    if (url.pathname.startsWith('/api/v1/')) {
      if (!(await isApiAuthorized(request)))
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      return handleApi(request);
    }

    // The order page's live connection to its OrderAgent (Agents SDK WebSocket + RPC).
    if (url.pathname.startsWith('/agents/order-agent/')) {
      if (!(await isSignedIn(request))) return new Response('Unauthorized', { status: 401 });
      return engine().fetch(new Request(`https://engine${url.pathname}${url.search}`, request));
    }

    // Order documents (invoices, POs, inbound POs) from R2.
    if (url.pathname.startsWith('/docs/orders/')) {
      if (!(await isSignedIn(request))) return new Response('Unauthorized', { status: 401 });
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
