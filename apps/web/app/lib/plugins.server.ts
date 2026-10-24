/**
 * Installed plugins, as the web app sees them: their status and manifests (from the engine, which
 * validates them) and their pages under `/plugins/<id>/`, forwarded to the plugin's own Worker
 * (`PLUGIN_<ID>`). See docs/plugins.md.
 *
 * The forwarding is a trust boundary in both directions:
 * - In: only a short list of request headers goes through, and never the cookie or authorization.
 *   A page request carries the signed principal and needs the manifest's `pageRole`. The
 *   manifest's `publicPaths` go through with no principal, rate-limited per caller and size-capped,
 *   for callers that authenticate to the plugin themselves.
 * - Out: a plugin's response can't set cookies on the app's domain, and gets this app's strict
 *   content security policy and framing rules whatever it asked for.
 */

import { env } from 'cloudflare:workers';
import {
  atLeast,
  type PluginManifest,
  type PluginStatus,
  pluginBinding,
  withPlugins,
} from '@orderloop/core';
import { clientIp } from './audit.server';
import { principal, sessionId, setupDue } from './auth.server';
import { engine } from './env.server';
import { setPrincipalHeader } from './principal.server';
import { overBudget } from './rate-limit';

/** `/plugins/<id>/…`: the only paths forwarded to a plugin. `/plugins` itself is the admin page. */
const PLUGIN_PATH = /^\/plugins\/([a-z][a-z0-9-]{1,30})\//;

/** The plugin a path is forwarded to, or null. */
export const pluginPathId = (pathname: string) => PLUGIN_PATH.exec(pathname)?.[1] ?? null;

/** The largest request body forwarded to a plugin. */
export const MAX_PLUGIN_BODY = 10 * 1024 * 1024;

/** Request headers a plugin may see; everything else (cookies, credentials, proxies') stays here. */
const FORWARDED = ['accept', 'accept-language', 'content-type', 'content-length', 'user-agent'];

/** Response headers that describe the connection, not the page; never passed on. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * What every plugin response carries, replacing anything the plugin set: scripts only from this
 * origin (no inline script), no plugins or framing, and forms that post back here.
 */
const PLUGIN_RESPONSE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
};

const STATUS_TTL_MS = 60_000;
let cached: { at: number; statuses: PluginStatus[] } | null = null;

/**
 * Every plugin binding the engine has and what it runs of each, cached for a minute per isolate.
 * If the engine can't say, the app carries on with what it last knew (or no plugins) rather than
 * failing every page.
 */
export async function pluginStatuses(): Promise<PluginStatus[]> {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.statuses;
  try {
    const statuses = await engine().pluginCatalog();
    cached = { at: Date.now(), statuses };
    return statuses;
  } catch (err) {
    console.error('plugin catalog unavailable', err);
    return cached?.statuses ?? [];
  }
}

/** The manifests of the plugins this deployment runs. */
export async function pluginManifests(): Promise<PluginManifest[]> {
  return (await pluginStatuses()).flatMap((s) => (s.manifest ? [s.manifest] : []));
}

/** Node lookups with the installed plugins' nodes, for validating flows. */
export async function nodeRegistry() {
  return withPlugins(await pluginManifests());
}

function binding(id: string): Fetcher | undefined {
  return (env as unknown as Record<string, Fetcher | undefined>)[pluginBinding(id)];
}

/** Errors the stream once more than `max` bytes have gone through it. */
function capped(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('Request body too large'));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** The plugin's response with only what may reach the browser, under this app's rules. */
function sanitized(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete('set-cookie');
  for (const h of HOP_BY_HOP) headers.delete(h);
  for (const [k, v] of Object.entries(PLUGIN_RESPONSE_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Forwards a request under `/plugins/<id>/` to that plugin, or 404 when it isn't installed. */
export async function pluginFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = pluginPathId(url.pathname);
  const target = id ? binding(id) : undefined;
  const manifest = id ? (await pluginManifests()).find((m) => m.id === id) : undefined;
  if (!id || !target || !manifest) return new Response('Not found', { status: 404 });

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_PLUGIN_BODY) return new Response('Request body too large', { status: 413 });

  const headers = new Headers();
  for (const h of FORWARDED) {
    const v = request.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (manifest.publicPaths.includes(url.pathname)) {
    const limited = await overBudget('WEBHOOK_LIMIT', `plugin:${id}:${clientIp(request)}`);
    if (limited) return limited;
  } else {
    const caller = await principal(request);
    if (!caller) return new Response('Unauthorized', { status: 401 });
    const due = setupDue(caller);
    if (due) return new Response(due, { status: 403 });
    if (!atLeast(caller.role, manifest.pageRole)) return new Response('Forbidden', { status: 403 });
    const session = caller.kind === 'user' ? await sessionId(request) : undefined;
    await setPrincipalHeader(headers, { ...caller, ...(session ? { session } : {}) }, url.pathname);
  }

  const body =
    request.body && !['GET', 'HEAD'].includes(request.method)
      ? capped(request.body, MAX_PLUGIN_BODY)
      : null;
  const forwarded = new Request(`https://plugin${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    // A streamed body needs half duplex outside workerd (Node's fetch, in the tests).
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
  return sanitized(await target.fetch(forwarded));
}
