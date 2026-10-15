import { A2A_PATH, decodePrincipal, PRINCIPAL_HEADER } from '@orderloop/core';
import { a2aAgent } from '../namespaces';

export { A2A_PATH };

/**
 * Sends a forwarded A2A request to the caller's own A2AAgent, or 401 without its principal
 * header. Named by kind and id, so a token and the person who made it keep separate tasks.
 */
export function handleA2A(request: Request, env: Env): Promise<Response> {
  const p = decodePrincipal(request.headers.get(PRINCIPAL_HEADER));
  if (!p) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
  return a2aAgent(env, `${p.kind}:${p.id}`).fetch(request);
}
