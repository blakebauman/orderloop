/**
 * The agents reachable over the web app's proxy (`/agents/<agent>/<name>`), in the deployment's
 * jurisdiction. A cart's socket is checked before it opens (./cart/gate.ts).
 */

import { routeAgentRequest } from 'agents';
import { cartGate } from './cart/gate';
import { scopedEnv } from './namespaces';

export async function routeAgents(request: Request, env: Env): Promise<Response> {
  // Keyed on the route the SDK matched, not the path's spelling, so no path reaches a cart unchecked.
  const gate = (req: Request, route: { className: string; name: string }) =>
    route.className === 'CART_AGENT' ? cartGate(env, req, route.name) : undefined;
  return (
    (await routeAgentRequest(request, scopedEnv(env), {
      onBeforeConnect: gate,
      onBeforeRequest: gate,
    })) ?? new Response('Not found', { status: 404 })
  );
}
