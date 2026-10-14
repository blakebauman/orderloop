/**
 * orderloop-engine. No public routes: the web app reaches it through a service binding, as RPC
 * (`EngineApi`) or plain fetch for the health check, the agent WebSockets it proxies, MCP
 * (`/mcp`, see ./mcp.ts) and A2A (`/a2a`, see ./a2a/).
 * Cloudflare Email Routing delivers inbound order email to `email()` (see ./email.ts).
 */

import { routeAgentRequest } from 'agents';
import { A2A_PATH, handleA2A } from './a2a/route';
import { receiveEmail } from './email';
import { handleMcp, MCP_PATH } from './mcp';

export { A2AAgent } from './a2a/agent';
export { OrderAgent } from './agent';
export { EngineApi } from './api';
export { AssistantAgent } from './assistant/agent';
export { Replenish } from './replenish';
export { OrderLoop } from './workflow';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-engine' });
    if (url.pathname === MCP_PATH) return handleMcp(request);
    if (url.pathname === A2A_PATH) return handleA2A(request, env);
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  async email(message, env) {
    const outcome = await receiveEmail(message, env);
    console.log('email intake', JSON.stringify({ to: message.to, ...outcome }));
  },
} satisfies ExportedHandler<Env>;
