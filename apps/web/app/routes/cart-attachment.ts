/**
 * One of a cart's files, downloaded, for staff or the cart's own buyer. Served as an attachment
 * under a CSP that runs nothing, so a file can't act on the app's origin.
 */

import { cartActor, readAttachment } from '~/lib/cart-attachments.server';
import type { Route } from './+types/cart-attachment';

export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await cartActor(request, params.cartId);
  if (!actor) return new Response('Unauthorized', { status: 401 });
  const found = await readAttachment(params.cartId, params.attachmentId, actor);
  if (!found) return new Response('Not found', { status: 404 });
  const { attachment: a, body } = found;
  return new Response(body, {
    headers: {
      'content-type': a.type,
      'content-length': String(a.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}
