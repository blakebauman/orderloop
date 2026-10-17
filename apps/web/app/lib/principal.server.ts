import { env } from 'cloudflare:workers';
import {
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  type ProxiedPrincipal,
  signPrincipal,
} from '@orderloop/core';

/**
 * Sets the signed principal header on a request the web app forwards to the engine at `path`,
 * replacing whatever the caller sent. The engine checks the signature with the same
 * `PRINCIPAL_KEY`; local dev (`vite dev`) uses a fixed key when none is set.
 */
export async function setPrincipalHeader(headers: Headers, p: ProxiedPrincipal, path: string) {
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key)
    throw new Error('PRINCIPAL_KEY is not set: the engine would refuse every forwarded call');
  headers.set(PRINCIPAL_HEADER, await signPrincipal(key, p, path));
}
