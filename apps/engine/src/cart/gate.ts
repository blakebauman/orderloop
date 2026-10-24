/**
 * What may reach a cart's agent from outside. Unlike an order's socket, a cart's sends the whole
 * cart the moment it opens, so the principal is checked before the request reaches the object:
 * a signature for this cart's path (`forwardedPrincipal`), a live sign-in with at least the
 * viewer role, and a cart that exists (a socket can't create one).
 */

import { atLeast } from '@orderloop/core';
import { carts, createDb } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { forwardedGuest, forwardedPrincipal, livePrincipal } from '../principal';

/** `name` is the object name the SDK routes to, checked against D1 as it is. */
export async function cartGate(
  env: Env,
  request: Request,
  name: string,
): Promise<Response | undefined> {
  const signed = await forwardedPrincipal(env, request);
  if (signed) {
    const p = await livePrincipal(env, signed);
    if (!p) return new Response('Sign in to open this cart.', { status: 401 });
    if (!atLeast(p.role, 'viewer')) return new Response('Forbidden', { status: 403 });
  } else {
    // An external cart's buyer, admitted to that one cart only.
    const guest = await forwardedGuest(env, request);
    if (!guest || guest.cartId !== name)
      return new Response('Sign in to open this cart.', { status: 401 });
    const row = await createDb(env.DB)
      .select({ pluginId: carts.pluginId, status: carts.status })
      .from(carts)
      .where(eq(carts.id, name))
      .get();
    if (!row?.pluginId) return new Response('Forbidden', { status: 403 });
    if (row.status === 'canceled') return new Response('This cart has closed.', { status: 410 });
    return undefined;
  }
  const row = await createDb(env.DB)
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.id, name))
    .get();
  if (!row) return new Response('Not found', { status: 404 });
  return undefined;
}
