/**
 * Installed plugins, as the web app sees them: their manifests (from the engine, which validates
 * them) and their pages under `/plugins/<id>/`, forwarded to the plugin's own Worker
 * (`PLUGIN_<ID>`). A page request carries the signed principal, like the engine's agent sockets;
 * the manifest's `publicPaths` go through with none, for callers that authenticate to the plugin
 * themselves. See docs/plugins.md.
 */

import { env } from 'cloudflare:workers';
import { type PluginManifest, pluginBinding, withPlugins } from '@orderloop/core';
import { principal, sessionId, setupDue } from './auth.server';
import { engine } from './env.server';
import { setPrincipalHeader } from './principal.server';

export const PLUGINS_PATH = '/plugins/';

const MANIFEST_TTL_MS = 60_000;
let cached: { at: number; manifests: PluginManifest[] } | null = null;

/**
 * The installed plugins' manifests, cached for a minute per isolate. If the engine can't say, the
 * app carries on as if none were installed rather than failing every page.
 */
export async function pluginManifests(): Promise<PluginManifest[]> {
  if (cached && Date.now() - cached.at < MANIFEST_TTL_MS) return cached.manifests;
  try {
    const manifests = await engine().pluginCatalog();
    cached = { at: Date.now(), manifests };
    return manifests;
  } catch (err) {
    console.error('plugin catalog unavailable', err);
    return cached?.manifests ?? [];
  }
}

/** Node lookups with the installed plugins' nodes, for validating flows. */
export async function nodeRegistry() {
  return withPlugins(await pluginManifests());
}

function binding(id: string): Fetcher | undefined {
  return (env as unknown as Record<string, Fetcher | undefined>)[pluginBinding(id)];
}

/** Forwards a request under `/plugins/<id>/` to that plugin, or 404 when it isn't installed. */
export async function pluginFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.pathname.slice(PLUGINS_PATH.length).split('/')[0] ?? '';
  const target = binding(id);
  const manifest = (await pluginManifests()).find((m) => m.id === id);
  if (!target || !manifest) return new Response('Not found', { status: 404 });

  const headers = new Headers(request.headers);
  // Credentials stay here: a plugin trusts the principal header alone.
  headers.delete('cookie');
  headers.delete('authorization');
  if (!manifest.publicPaths.includes(url.pathname)) {
    const caller = await principal(request);
    if (!caller) return new Response('Unauthorized', { status: 401 });
    const due = setupDue(caller);
    if (due) return new Response(due, { status: 403 });
    const session = caller.kind === 'user' ? await sessionId(request) : undefined;
    await setPrincipalHeader(headers, { ...caller, ...(session ? { session } : {}) }, url.pathname);
  }
  return target.fetch(
    new Request(`https://plugin${url.pathname}${url.search}`, new Request(request, { headers })),
  );
}
