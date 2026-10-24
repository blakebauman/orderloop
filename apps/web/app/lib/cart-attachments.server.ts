/**
 * Files on a cart (`CartAttachment`), stored in the documents bucket at `cartAttachmentKey` by the
 * web app and listed by the cart's agent. Staff reach them from the Carts page, and an external
 * cart's buyer from theirs, by the cookie their start link set for that cart alone.
 */

import {
  attachmentName,
  attachmentProblem,
  type CartActor,
  canReadCart,
  cartAttachmentKey,
  newId,
} from '@orderloop/core';
import { principal, setupDue } from './auth.server';
import { cartGuest } from './cart-guest.server';
import { docs, engine } from './env.server';

/** Who is asking about `cartId`: signed-in staff, else the buyer this cart admitted, else null. */
export async function cartActor(request: Request, cartId: string): Promise<CartActor | null> {
  const caller = await principal(request);
  if (caller && !setupDue(caller))
    return { kind: 'staff', id: caller.id, name: caller.name, role: caller.role };
  const guest = await cartGuest(request, cartId);
  return guest ? { kind: 'guest', id: guest.id, name: guest.name } : null;
}

/**
 * Stores an uploaded file and adds it to the cart, or says why not. The agent decides whether the
 * caller may change the cart; a file it refuses is deleted again.
 */
export async function uploadAttachment(
  cartId: string,
  actor: CartActor,
  file: File,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const snapshot = await engine().cartSnapshot(cartId);
  if (!snapshot?.cart) return { ok: false, error: 'No such cart.', status: 404 };
  if (!canReadCart(snapshot.cart, actor) || (actor.kind === 'guest' && !snapshot.cart.external))
    return { ok: false, error: 'Forbidden', status: 403 };
  const problem = attachmentProblem(file, snapshot.attachments?.length ?? 0);
  if (problem) return { ok: false, error: problem, status: 400 };
  const id = newId('att');
  const key = cartAttachmentKey(cartId, id);
  const name = attachmentName(file.name);
  await docs().put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { cartId, name },
  });
  const added = await engine().attachToCart(
    cartId,
    { id, name, type: file.type, size: file.size, key },
    actor,
  );
  if (!added.ok) {
    await docs().delete(key);
    return { ok: false, error: added.error, status: 400 };
  }
  return { ok: true };
}

/** A cart's file for someone who may read the cart, or null. */
export async function readAttachment(cartId: string, id: string, actor: CartActor) {
  const snapshot = await engine().cartSnapshot(cartId);
  const cart = snapshot?.cart;
  if (!cart || !canReadCart(cart, actor)) return null;
  // A guest's cookie is for this cart only; cartActor already scoped it to `cartId`.
  const a = snapshot.attachments?.find((f) => f.id === id);
  if (!a || a.key !== cartAttachmentKey(cartId, id)) return null;
  const obj = await docs().get(a.key);
  return obj ? { attachment: a, body: obj.body } : null;
}
