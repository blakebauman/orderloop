import { env } from 'cloudflare:workers';
import {
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  pluginKey,
  signPrincipal,
} from '@orderloop/core';

/**
 * Sets the signed principal header on a request the web app forwards to the engine at `path`,
 * replacing whatever the caller sent. The engine checks the signature with the same
 * `PRINCIPAL_KEY`; local dev (`vite dev`) uses a fixed key when none is set.
 */
export async function setPrincipalHeader(headers: Headers, p: ProxiedPrincipal, path: string) {
  headers.set(PRINCIPAL_HEADER, await signPrincipal(principalKey(), p, path));
}

/**
 * The same header for a request forwarded to plugin `id`, signed with that plugin's own key
 * (`pluginKey`), which the engine and other plugins refuse. It carries no session id: a plugin
 * doesn't need one, and shouldn't hold it.
 */
export async function setPluginPrincipalHeader(
  headers: Headers,
  p: Principal,
  path: string,
  id: string,
) {
  const { kind, id: who, name, role, email } = p;
  const key = await pluginKey(principalKey(), id);
  headers.set(
    PRINCIPAL_HEADER,
    await signPrincipal(key, { kind, id: who, name, role, ...(email ? { email } : {}) }, path),
  );
}

function principalKey() {
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key)
    throw new Error('PRINCIPAL_KEY is not set: the engine would refuse every forwarded call');
  return key;
}
