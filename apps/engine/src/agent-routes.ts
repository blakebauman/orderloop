/**
 * The agents reachable over the web app's proxy (`/agents/<agent>/<name>`), in the deployment's
 * jurisdiction. Each socket or request is checked before it reaches the object: a cart's in
 * ./cart/gate.ts, an order's and an assistant's here. Any other agent isn't reachable this way.
 */

import { atLeast } from '@orderloop/core';
import { createDb, orders } from '@orderloop/db';
import { routeAgentRequest } from 'agents';
import { eq } from 'drizzle-orm';
import { cartGate } from './cart/gate';
import { scopedEnv } from './namespaces';
import { forwardedPrincipal, livePrincipal } from './principal';

/**
 * An order page's socket: a principal signed for this order's path, signed in now with at least
 * the viewer role, and an order that exists (a socket can't create one).
 */
async function orderGate(env: Env, request: Request, name: string) {
  const signed = await forwardedPrincipal(env, request);
  const p = signed ? await livePrincipal(env, signed) : null;
  if (!p) return new Response('Sign in to open this order.', { status: 401 });
  if (!atLeast(p.role, 'viewer')) return new Response('Forbidden', { status: 403 });
  const row = await createDb(env.DB)
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, name))
    .get();
  if (!row) return new Response('Not found', { status: 404 });
  return undefined;
}

/** The assistant panel: only its own person, signed in now, reaches an assistant. */
async function assistantGate(env: Env, request: Request, name: string) {
  const signed = await forwardedPrincipal(env, request);
  const p = signed ? await livePrincipal(env, signed) : null;
  if (!p) return new Response('Sign in to use the assistant.', { status: 401 });
  if (p.id !== name) return new Response('Not your assistant', { status: 403 });
  return undefined;
}

const GATES: Record<
  string,
  (env: Env, request: Request, name: string) => Promise<Response | undefined>
> = {
  CART_AGENT: cartGate,
  ORDER_AGENT: orderGate,
  ASSISTANT_AGENT: assistantGate,
};

export async function routeAgents(request: Request, env: Env): Promise<Response> {
  // The SDK would hand `/agents/<agent>/<name>/sub/<class>/<name>` on to a child object of any
  // agent class, past the gates; none of these agents has children.
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  if (segments.slice(3).includes('sub')) return new Response('Not found', { status: 404 });
  // Keyed on the route the SDK matched, not the path's spelling, so no path reaches an agent
  // unchecked.
  const gate = (req: Request, route: { className: string; name: string }) => {
    const check = GATES[route.className];
    return check
      ? check(env, req, route.name)
      : Promise.resolve(new Response('Not found', { status: 404 }));
  };
  return (
    (await routeAgentRequest(request, scopedEnv(env), {
      onBeforeConnect: gate,
      onBeforeRequest: gate,
    })) ?? new Response('Not found', { status: 404 })
  );
}
