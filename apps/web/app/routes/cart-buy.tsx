/**
 * An external cart, for the buyer it was opened for (a punchout session): the same live cart as
 * staff see, without staff controls, and with the button that sends it back to the buyer's system.
 * Only the cookie a redeemed start link set admits them (lib/cart-guest.server.ts), to this cart
 * alone. The page may be framed by the origins the plugin named, and its return form posts only
 * to the cart's return URL (`EMBED_HEADER`, folded into the CSP by entry.server.tsx).
 */

import { products } from '@orderloop/db';
import { data, type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router';
import { CartView } from '~/components/cart-view';
import { cartGuest } from '~/lib/cart-guest.server';
import { EMBED_HEADER } from '~/lib/csp';
import { db, engine } from '~/lib/env.server';
import { customerNames } from '~/lib/orders.server';
import type { Route } from './+types/cart-buy';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.snapshot.cart?.title ?? 'Cart'} · OrderLoop` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  const guest = await cartGuest(request, params.cartId);
  if (!guest)
    throw data('Open this cart from your purchasing system.', {
      status: 401,
      headers: { 'cache-control': 'no-store' },
    });
  const snapshot = await engine().cartSnapshot(params.cartId);
  const external = snapshot?.cart?.external;
  if (!snapshot?.cart || !external) throw data('Cart not found', { status: 404 });
  const [names, catalog] = await Promise.all([
    customerNames([snapshot.cart.customerId]),
    db().select({ sku: products.sku, name: products.name }).from(products).orderBy(products.sku),
  ]);
  return data(
    {
      snapshot,
      guest,
      customerName: snapshot.cart.customerId ? (names[snapshot.cart.customerId] ?? null) : null,
      products: catalog,
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

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) {
  return currentParams.cartId !== nextParams.cartId;
}

export default function CartBuyPage() {
  const { snapshot, guest, customerName, products } = useLoaderData<typeof loader>();
  return (
    <main id="main" className="min-h-dvh bg-background">
      <CartView
        key={snapshot.cart!.id}
        snapshot={snapshot}
        customerName={customerName}
        products={products}
        mode="guest"
        meId={guest.id}
      />
    </main>
  );
}
