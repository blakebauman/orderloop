/**
 * Demo mode (`DEMO_MODE=true`, set only on a demo deployment such as demo.orderloop.app). Visitors
 * sign in with one click as a shared operator and can run and change orders and flows, but not the
 * workspace's people, tokens, integrations, webhook subscriptions, settings or connected apps, and
 * not the shared account itself. The deployment is reset nightly (.github/workflows/demo-reset.yml).
 */

import { env } from 'cloudflare:workers';

export const isDemo = () => (env as { DEMO_MODE?: string }).DEMO_MODE === 'true';

/** The shared visitor account. It has no password: the sign-in page's demo button is the way in. */
export const DEMO_USER = {
  id: 'usr_demo',
  email: 'demo@orderloop.app',
  name: 'Demo visitor',
  role: 'operator',
} as const;

/** Changes nobody may make in a demo: they would reach past it, or spoil it for the next visitor. */
const LOCKED_WRITES = ['/team', '/account'];
/** Not even readable: credentials and outbound endpoints live here. */
const LOCKED = [
  '/oauth/authorize',
  '/api/v1/integrations',
  '/api/v1/webhook-subscriptions',
  '/api/v1/ucp',
  '/scim/v2',
];

const under = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`) || path === `${prefix}.data`;

export const DEMO_REFUSAL =
  'This is the OrderLoop demo, so people, tokens, integrations, webhooks and connected apps are off. Everything else works and is reset every night.';

/** A 403 for what a demo visitor may not do, or null outside demo mode or for anything else. */
export function demoRefusal(request: Request): Response | null {
  if (!isDemo()) return null;
  const path = new URL(request.url).pathname;
  const write = request.method !== 'GET' && request.method !== 'HEAD';
  if (LOCKED.some((p) => under(path, p)) || (write && LOCKED_WRITES.some((p) => under(path, p))))
    return Response.json({ error: DEMO_REFUSAL }, { status: 403 });
  return null;
}
