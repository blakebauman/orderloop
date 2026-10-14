/**
 * orderloop-engine. No public routes: the web app reaches it through a service binding, as RPC
 * (`EngineApi`) or plain fetch for the health check and the OrderAgent WebSocket it proxies.
 * Cloudflare Email Routing delivers inbound order email to `email()` (see ./email.ts).
 */

import { routeAgentRequest } from 'agents';
import { receiveEmail } from './email';

export { OrderAgent } from './agent';
export { EngineApi } from './api';
export { AssistantAgent } from './assistant/agent';
export { Replenish } from './replenish';
export { OrderLoop } from './workflow';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-engine' });
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  async email(message, env) {
    const outcome = await receiveEmail(message, env);
    console.log('email intake', JSON.stringify({ to: message.to, ...outcome }));
  },
} satisfies ExportedHandler<Env>;
