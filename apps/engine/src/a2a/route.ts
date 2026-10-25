import { A2A_PATH } from '@orderloop/core';
import { a2aAgent } from '../namespaces';
import { forwardedPrincipal } from '../principal';

export { A2A_PATH };

/**
 * The A2AAgent a caller's tasks and push configs live in: `<kind>:<id>`, and `:<grant>` for a
 * connected app, so a token and the person who made it, and two apps one person connected, each
 * keep their own tasks and push credentials.
 */
export const a2aCaller = (p: { kind: string; id: string; grant?: string }) =>
  p.grant ? `${p.kind}:${p.id}:${p.grant}` : `${p.kind}:${p.id}`;

/** Sends a forwarded A2A request to the caller's own A2AAgent, or 401 without its signed principal header. */
export async function handleA2A(request: Request, env: Env): Promise<Response> {
  const p = await forwardedPrincipal(env, request);
  if (!p) return new Response('Unauthorized', { status: 401 });
  return a2aAgent(env, a2aCaller(p)).fetch(request);
}
