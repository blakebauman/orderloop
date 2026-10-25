import { env } from 'cloudflare:workers';
import { type ProxiedPrincipal, type RpcActor, signPrincipal, signRpcActor } from '@orderloop/core';

/** The principal header the web Worker would sign for a request to `path`. */
export const signed = (p: ProxiedPrincipal, path: string) =>
  signPrincipal((env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!, p, path);

/** An actor the web Worker would sign for one `EngineRpc` call (`decide:<id>`, `cart:<id>`). */
export const signedActor = (a: RpcActor, call: string) =>
  signRpcActor((env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!, a, call);
