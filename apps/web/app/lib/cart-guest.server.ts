/**
 * The buyer of an external cart (a punchout session) in the web app. A plugin hands the buyer's
 * system a one-time start link (`/cart/start/<cartId>/<token>`); redeeming it sets a cookie that
 * keeps that buyer on that cart, and nowhere else, until the cart closes. The cookie is its own
 * envelope (`signCartGuestSession`), never a session: it opens no staff page and no other cart.
 */

import { env } from 'cloudflare:workers';
import { type CartGuest, signCartGuestSession, verifyCartGuestSession } from '@orderloop/core';
import { data } from 'react-router';
import { cookie } from './auth.server';
import { ANY_HTTPS_FRAMER, EMBED_HEADER } from './csp';
import { principalKey } from './principal.server';

const COOKIE_RE = /^cart_[a-z0-9]+$/;

/** One cookie per cart, so a buyer with two carts open keeps both. */
const cookieName = (cartId: string) => `ol_${cartId}`;

/**
 * The cookie for a redeemed start link. `SameSite=None` and `Partitioned` because the buyer's
 * procurement system usually frames the cart (or opens it from its own page), so it is a
 * third-party cookie there, kept in that site's partition.
 */
export async function guestCookie(g: CartGuest, expiresAt: number): Promise<string> {
  const value = await signCartGuestSession(principalKey(), g, expiresAt);
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${cookieName(g.cartId)}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
}

/** The buyer this request carries for `cartId`, or null. */
export function cartGuest(request: Request, cartId: string): Promise<CartGuest | null> {
  if (!COOKIE_RE.test(cartId)) return Promise.resolve(null);
  return verifyCartGuestSession(
    [principalKey(), (env as { PRINCIPAL_KEY_PREVIOUS?: string }).PRINCIPAL_KEY_PREVIOUS],
    cookie(request, cookieName(cartId)),
    cartId,
  );
}

/**
 * Why a buyer can't have a cart page, thrown from its loader and shown by `CartRefusal`. The
 * buyer's system usually frames these pages, so the refusal may be framed by any https page (it
 * holds nothing but the message); otherwise they'd see a blocked frame instead of the reason.
 */
export function cartRefusal(message: string, status: number) {
  return data(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      [EMBED_HEADER]: JSON.stringify({ frameAncestors: [ANY_HTTPS_FRAMER] }),
    },
  });
}
