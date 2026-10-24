/**
 * The agents reachable over the web app's proxy (`/agents/<agent>/<name>`), in the deployment's
 * jurisdiction. A cart's socket is checked before it opens (./cart/gate.ts).
 */

import { routeAgentRequest } from 'agents';
import { CART_AGENT_PATH, cartGate } from './cart/gate';
import { scopedEnv } from './namespaces';

export async function routeAgents(request: Request, env: Env): Promise<Response> {
  const gate = (req: Request) =>
    new URL(req.url).pathname.startsWith(CART_AGENT_PATH) ? cartGate(env, req) : undefined;
  return (
    (await routeAgentRequest(request, scopedEnv(env), {
      onBeforeConnect: gate,
      onBeforeRequest: gate,
    })) ?? new Response('Not found', { status: 404 })
  );
}
