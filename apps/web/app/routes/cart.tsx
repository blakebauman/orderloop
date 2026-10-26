/**
 * One cart, live, for staff: the loader renders the agent's snapshot and `CartView` keeps it current
 * over the cart's socket (components/cart-view.tsx).
 */

import { data, type ShouldRevalidateFunctionArgs, useLoaderData } from 'react-router';
import { CartView } from '~/components/cart-view';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { customerNames } from '~/lib/orders.server';
import { useCan, useMe } from '~/lib/use-me';
import type { Route } from './+types/cart';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.snapshot.cart?.title ?? 'Cart'} · Carts · OrderLoop` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const snapshot = await engine().cartSnapshot(params.cartId);
  if (!snapshot?.cart) throw data('Cart not found', { status: 404 });
  const names = await customerNames([snapshot.cart.customerId]);
  return {
    snapshot,
    customerName: snapshot.cart.customerId ? (names[snapshot.cart.customerId] ?? null) : null,
  };
}

/** The socket keeps the cart current; the loader runs again only for another cart. */
export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) {
  return currentParams.cartId !== nextParams.cartId;
}

export default function CartPage() {
  const { snapshot, customerName } = useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  const me = useMe();
  return (
    <CartView
      key={snapshot.cart!.id}
      snapshot={snapshot}
      customerName={customerName}
      mode="staff"
      meId={me?.id ?? null}
      canOperate={canOperate}
    />
  );
}
