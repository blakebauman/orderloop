/** Adding a file to a cart: a multipart POST from the cart page (components/cart-view.tsx). */

import { data } from 'react-router';
import { cartActor, uploadAttachment } from '~/lib/cart-attachments.server';
import type { Route } from './+types/cart-attachments';

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await cartActor(request, params.cartId);
  if (!actor) throw data({ error: 'Unauthorized' }, { status: 401 });
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw data({ error: 'Choose a file.' }, { status: 400 });
  const r = await uploadAttachment(params.cartId, actor, file);
  if (!r.ok) throw data({ error: r.error }, { status: r.status });
  return { ok: true };
}
