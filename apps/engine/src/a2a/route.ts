import { A2A_PATH } from '@orderloop/core';
import { a2aAgent } from '../namespaces';
import { forwardedPrincipal } from '../principal';

export { A2A_PATH };

/**
 * Sends a forwarded A2A request to the caller's own A2AAgent, or 401 without its signed principal
 * header. Named by kind and id, so a token and the person who made it keep separate tasks.
 */
export async function handleA2A(request: Request, env: Env): Promise<Response> {
  const p = await forwardedPrincipal(env, request);
  if (!p) return new Response('Unauthorized', { status: 401 });
  return a2aAgent(env, `${p.kind}:${p.id}`).fetch(request);
}
