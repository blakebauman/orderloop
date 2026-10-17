import { env } from 'cloudflare:workers';
import { type ProxiedPrincipal, signPrincipal } from '@orderloop/core';

/** The principal header the web Worker would sign for a request to `path`. */
export const signed = (p: ProxiedPrincipal, path: string) =>
  signPrincipal((env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!, p, path);
