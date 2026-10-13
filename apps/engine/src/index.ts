/**
 * orderloop-engine. No public routes: the web app reaches it through a service binding, as RPC
 * (`EngineApi`) or plain fetch for the health check and the OrderAgent WebSocket it proxies.
 */

import { routeAgentRequest } from 'agents';

export { OrderAgent } from './agent';
export { EngineApi } from './api';
export { Replenish } from './replenish';
export { OrderLoop } from './workflow';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-engine' });
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
