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
 * - Out: only an allowlist of response headers gets through (so nothing that acts on the whole
 *   origin, such as cookies, HSTS or a service worker's scope), redirects stay within the plugin,
 *   and the page gets this app's content security policy, which allows no script at all.
 * - The principal is signed with the plugin's own key (`pluginKey`), which nothing else accepts,
 *   and carries no session id.
 */

import { env } from 'cloudflare:workers';
import {
  atLeast,
  type PluginManifest,
  type PluginRuntime,
  type PluginStatus,
  pluginBinding,
  withPlugins,
} from '@orderloop/core';
import { clientIp } from './audit.server';
import { principal, setupDue } from './auth.server';
import { engine } from './env.server';
import { setPluginPrincipalHeader } from './principal.server';
import { overBudget } from './rate-limit';

/** `/plugins/<id>/…`: the only paths forwarded to a plugin. `/plugins` itself is the admin page. */
const PLUGIN_PATH = /^\/plugins\/([a-z][a-z0-9-]{1,30})\//;

/** The plugin a path is forwarded to, or null. */
export const pluginPathId = (pathname: string) => PLUGIN_PATH.exec(pathname)?.[1] ?? null;

/**
 * Plugins' aliases, from the deployment's registry (`plugins.<id>.alias`, rendered as
 * `PLUGIN_ALIASES`): another path a plugin's pages answer at, such as `/punchout/` for
 * `/plugins/punchout/`. The registry chooses it, never the plugin, and fleet refuses one that is
 * an app path or another plugin's.
 */
export function pluginAliases(): Record<string, string> {
  const raw = (env as { PLUGIN_ALIASES?: string }).PLUGIN_ALIASES;
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (e): e is [string, string] =>
          typeof e[1] === 'string' && /^\/[a-z][a-z0-9-]{1,30}\/$/.test(e[0]),
      ),
    );
  } catch {
    console.error('PLUGIN_ALIASES is not JSON; no aliases');
    return {};
  }
}

/** The plugin path an aliased path stands for (`/punchout/cxml/setup` → `/plugins/punchout/cxml/setup`), or null. */
export function unalias(pathname: string): string | null {
  for (const [alias, id] of Object.entries(pluginAliases()))
    if (pathname.startsWith(alias)) return `/plugins/${id}/${pathname.slice(alias.length)}`;
  return null;
}

/**
 * Whether `pathname` (or the plugin path its alias stands for) is one of an installed plugin's
 * `publicPaths`: forwarded with no sign-in and no cookie, so the cross-site check doesn't apply.
 */
export async function isPluginPublicPath(pathname: string): Promise<boolean> {
  const path = pluginPathId(pathname) ? pathname : unalias(pathname);
  const id = path ? pluginPathId(path) : null;
  if (!id || !path) return false;
  const status = (await pluginStatuses()).find((s) => s.id === id);
  return !!status?.manifest?.publicPaths.includes(path);
}

/** The largest request body forwarded to a plugin. */
export const MAX_PLUGIN_BODY = 10 * 1024 * 1024;

/** Request headers a plugin may see; everything else (cookies, credentials, proxies') stays here. */
const FORWARDED = ['accept', 'accept-language', 'content-type', 'content-length', 'user-agent'];

/**
 * Response headers a plugin's page may set; every other one is dropped. Headers that act on the
 * whole origin (cookies, HSTS, service-worker scope, reporting, site-data clearing, permissions)
 * must never come from a plugin.
 */
const RESPONSE_ALLOWED = [
  'cache-control',
  'content-disposition',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'vary',
];

/**
 * What every plugin response carries, replacing anything the plugin set: no script at all (a
 * plugin's page is server-rendered HTML whose links and forms come back here, checked), styles and
 * images only from this origin, no plugins or framing, and forms that post only to the plugin's own
 * pages (so never to an admin page, such as the one that installs plugins). A script
 * from a plugin would run with the viewer's session on this origin.
 */
const PLUGIN_RESPONSE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
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

/**
 * The plugin's response with only what may reach the browser, under this app's rules. A redirect
 * may only lead to the plugin's own pages; any other is refused rather than followed from this
 * origin.
 */
function sanitized(res: Response, id: string, origin: string): Response {
  const headers = new Headers();
  for (const h of RESPONSE_ALLOWED) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  const location = res.headers.get('location');
  if (location !== null) {
    const to = new URL(location, `${origin}/plugins/${id}/`);
    // Its own pages, or an external cart's start link (which only the plugin that opened the cart
    // was given): a punchout system opening the catalog in a frame follows it there.
    const start = /^\/cart\/start\/cart_[a-z0-9]+\/[0-9a-f]+$/.test(to.pathname) && !to.search;
    if (to.origin !== origin || (pluginPathId(to.pathname) !== id && !start))
      return new Response('A plugin may only redirect to its own pages', { status: 502 });
    headers.set('location', `${to.pathname}${to.search}`);
  }
  for (const [k, v] of Object.entries(PLUGIN_RESPONSE_HEADERS)) headers.set(k, v);
  headers.set(
    'content-security-policy',
    `${PLUGIN_RESPONSE_HEADERS['content-security-policy']}; form-action ${origin}/plugins/${id}/`,
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Where a plugin's pages are served: its own Worker's binding, or for a sandboxed plugin the
 * engine (`EngineRpc.pluginFetch`), the only Worker that can load it.
 */
function target(id: string, runtime: PluginRuntime): Pick<Fetcher, 'fetch'> | undefined {
  if (runtime === 'sandboxed') return { fetch: (r: Request) => engine().pluginFetch(id, r) };
  return binding(id);
}

/** Forwards a request under `/plugins/<id>/` to that plugin, or 404 when it isn't installed. */
export async function pluginFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = pluginPathId(url.pathname);
  const status = id ? (await pluginStatuses()).find((s) => s.id === id) : undefined;
  const manifest = status?.manifest ?? undefined;
  const to = id && status ? target(id, status.runtime) : undefined;
  if (!id || !to || !manifest) return new Response('Not found', { status: 404 });

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
    const limited = await overBudget('API_LIMIT', `plugin:${id}:${caller.id}`);
    if (limited) return limited;
    await setPluginPrincipalHeader(
      headers,
      caller,
      url.pathname,
      id,
      status?.source === 'installed' ? status.sha : undefined,
    );
  }

  const body =
    request.body && !['GET', 'HEAD'].includes(request.method)
      ? capped(request.body, MAX_PLUGIN_BODY)
      : null;
  // Where its pages also answer, so a page can show the shorter address (its own paths still work).
  const alias = Object.entries(pluginAliases()).find(([, p]) => p === id)?.[0];
  if (alias) headers.set('x-orderloop-alias', alias);
  const forwarded = new Request(`https://plugin${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    // A streamed body needs half duplex outside workerd (Node's fetch, in the tests).
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
  return sanitized(await to.fetch(forwarded), id, url.origin);
}
