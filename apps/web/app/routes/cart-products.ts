/**
 * Products to add to a cart, for its search field (components/cart-view.tsx): staff, or the buyer
 * the cart admitted, by the cookie their start link set for this cart alone. The engine searches
 * what the cart's quote prices and decides who may (`searchCartProducts`); this only says who asks.
 */

import { data } from 'react-router';
import { cartActor } from '~/lib/cart-attachments.server';
import { engine } from '~/lib/env.server';
import { signedActor } from '~/lib/principal.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/cart-products';

/** Characters of a search passed on: no SKU or product name is longer. */
const MAX_Q = 200;

export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await cartActor(request, params.cartId);
  if (!actor) throw data({ error: 'Unauthorized' }, { status: 401 });
  // A person's own budget, apart from their /api/v1 one (the binding counts per key): a buyer's
  // on their cart, since a cart's buyers share an id only with themselves.
  const limited = await overBudget(
    'API_LIMIT',
    actor.kind === 'guest' ? `cart-search:${params.cartId}:${actor.id}` : `cart-search:${actor.id}`,
  );
  if (limited) throw limited;
  const q = (new URL(request.url).searchParams.get('q') ?? '').slice(0, MAX_Q);
  const r = await engine().searchCartProducts(
    params.cartId,
    q,
    await signedActor(actor, `cart:${params.cartId}`),
  );
  if (!r.ok) throw data({ error: r.error }, { status: r.notFound ? 404 : 403 });
  const { ok: _ok, ...page } = r;
  return data(page, { headers: { 'cache-control': 'private, no-store' } });
}
