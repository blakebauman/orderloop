/**
 * An external cart, for the buyer it was opened for (a punchout session): the same live cart as
 * staff see, without staff controls, and with the button that sends it back to the buyer's system.
 * Only the cookie a redeemed start link set admits them (lib/cart-guest.server.ts), to this cart
 * alone. The page may be framed by the origins the plugin named, and its return form posts only
 * to the cart's return URL (`EMBED_HEADER`, folded into the CSP by entry.server.tsx).
 */

import { guestCartOpen } from '@orderloop/core';
import { data, type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router';
import { CartRefusal } from '~/components/cart-refusal';
import { CartView } from '~/components/cart-view';
import { cartGuest, cartRefusal } from '~/lib/cart-guest.server';
import { EMBED_HEADER } from '~/lib/csp';
import { engine } from '~/lib/env.server';
import { customerNames } from '~/lib/orders.server';
import type { Route } from './+types/cart-buy';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.snapshot.cart?.title ?? 'Cart'} · OrderLoop` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const guest = await cartGuest(request, params.cartId);
  if (!guest) throw cartRefusal('Open this cart from your purchasing system.', 401);
  const snapshot = await engine().cartSnapshot(params.cartId);
  const cart = snapshot?.cart;
  const external = cart?.external;
  if (!snapshot || !cart || !external) throw cartRefusal('This cart doesn’t exist.', 404);
  // The cart's socket refuses the buyer once it closes (the engine's cartGate); say so here
  // rather than render a cart that can't connect. A returned cart stays until its time, to post
  // it again.
  if (!guestCartOpen({ status: cart.status, expiresAt: external.expiresAt }, Date.now()))
    throw cartRefusal(
      'This cart has closed. Go back to your purchasing system and open the catalog again.',
      410,
    );
  const names = await customerNames([cart.customerId]);
  return data(
    {
      snapshot,
      guest,
      customerName: cart.customerId ? (names[cart.customerId] ?? null) : null,
    },
    {
      headers: {
        'cache-control': 'no-store',
        [EMBED_HEADER]: JSON.stringify({
          frameAncestors: external.frameOrigins,
          formAction: [external.returnUrl],
        }),
      },
    },
  );
}

export function headers({ errorHeaders, loaderHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export const ErrorBoundary = CartRefusal;

export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) {
  return currentParams.cartId !== nextParams.cartId;
}

export default function CartBuyPage() {
  const { snapshot, guest, customerName } = useLoaderData<typeof loader>();
  return (
    <main id="main" className="min-h-dvh bg-background">
      <CartView
        key={snapshot.cart!.id}
        snapshot={snapshot}
        customerName={customerName}
        mode="guest"
        meId={guest.id}
      />
    </main>
  );
}
