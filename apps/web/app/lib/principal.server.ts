import { env } from 'cloudflare:workers';
import {
  type CartGuest,
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  pluginKey,
  type RpcActor,
  type SignedActor,
  signCartGuest,
  signPrincipal,
  signRpcActor,
} from '@orderloop/core';

/**
 * Sets the signed principal header on a request the web app forwards to the engine at `path`,
 * replacing whatever the caller sent. The engine checks the signature with the same
 * `PRINCIPAL_KEY`; local dev (`vite dev`) uses a fixed key when none is set.
 */
export async function setPrincipalHeader(headers: Headers, p: ProxiedPrincipal, path: string) {
  headers.set(PRINCIPAL_HEADER, await signPrincipal(principalKey(), p, path));
}

/** The header for an external cart's buyer on that cart's socket (`signCartGuest`). */
export async function setGuestHeader(headers: Headers, g: CartGuest, path: string) {
  headers.set(PRINCIPAL_HEADER, await signCartGuest(principalKey(), g, path));
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

/**
 * Who is acting on an `EngineRpc` call, signed for that one call (`decide:<orderId>`,
 * `cart:<cartId>`): the engine takes it from nothing else.
 */
export function signedActor(actor: RpcActor, call: string): Promise<SignedActor> {
  return signRpcActor(principalKey(), actor, call);
}

/** A person or token as the staff actor on an approval: the record names them as `by`. */
export const decider = (p: Pick<Principal, 'id' | 'role'>, by: string): RpcActor => ({
  kind: 'staff',
  id: p.id,
  name: by,
  role: p.role,
});

export function principalKey() {
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key)
    throw new Error('PRINCIPAL_KEY is not set: the engine would refuse every forwarded call');
  return key;
}
