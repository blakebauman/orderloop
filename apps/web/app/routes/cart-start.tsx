/**
 * An external cart's one-time start link, as a plugin handed it to the buyer's system (a punchout
 * StartPage). Redeeming it admits the buyer to that cart (a cookie for it alone) and goes there.
 * It renders nothing of its own: a link that can't be redeemed shows `CartRefusal`, which the
 * buyer's frame may show (`cartRefusal`).
 */

import { redirect } from 'react-router';
import { CartRefusal } from '~/components/cart-refusal';
import { cartRefusal, guestCookie } from '~/lib/cart-guest.server';
import { engine } from '~/lib/env.server';
import type { Route } from './+types/cart-start';

export async function loader({ params }: Route.LoaderArgs) {
  const redeemed = /^cart_[a-z0-9]+$/.test(params.cartId)
    ? await engine().redeemCartStart(params.cartId, params.token)
    : null;
  if (!redeemed)
    throw cartRefusal(
      'This link has been used or has expired. Go back to your purchasing system and open the catalog again.',
      410,
    );
  return redirect(`/cart/${params.cartId}`, {
    headers: {
      'set-cookie': await guestCookie(redeemed.guest, redeemed.expiresAt),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export function headers({ errorHeaders, loaderHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export const ErrorBoundary = CartRefusal;
