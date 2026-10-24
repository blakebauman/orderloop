/** Opening carts, for EngineApi. A cart's own changes go through its agent (./agent.ts). */

import {
  type Cart,
  type CartState,
  type CreateCartInput,
  MAX_CART_TITLE,
  newId,
  quoteNodes,
} from '@orderloop/core';
import { carts, createDb, customers } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { loadFlowVersion } from '../flows';
import { cartAgent } from '../namespaces';

/** Why `flowId` can't price a cart, or null: it must exist and set prices (`commerce.price`). */
export async function cartFlowProblem(env: Env, flowId: string): Promise<string | null> {
  const flow = await loadFlowVersion(env, flowId);
  if (!flow) return 'That flow has no published version.';
  if (!quoteNodes(flow).some((n) => n.type === 'commerce.price'))
    return 'That flow doesn’t price orders (it has no Price lines step).';
  return null;
}

export async function createCart(
  env: Env,
  input: CreateCartInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim();
  if (!title || title.length > MAX_CART_TITLE)
    return { ok: false, error: `A title is 1 to ${MAX_CART_TITLE} characters.` };
  const problem = await cartFlowProblem(env, input.flowId);
  if (problem) return { ok: false, error: problem };
  if (input.customerId) {
    const found = await createDb(env.DB)
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .get();
    if (!found) return { ok: false, error: 'No such customer.' };
  }
  const now = Date.now();
  const cart: Cart = {
    id: newId('cart'),
    title,
    status: 'open',
    customerId: input.customerId ?? null,
    flowId: input.flowId,
    external: null,
    lines: [],
    promoCodes: [],
    quote: null,
    quotedVersion: 0,
    issues: [],
    orderId: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await cartAgent(env, cart.id).create(cart);
  return { ok: true, id: cart.id };
}

/** The cart's state, or null when no cart has the id (its agent is never woken for one). */
export async function cartSnapshot(env: Env, id: string): Promise<CartState | null> {
  const row = await createDb(env.DB)
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.id, id))
    .get();
  return row ? cartAgent(env, id).snapshot() : null;
}
