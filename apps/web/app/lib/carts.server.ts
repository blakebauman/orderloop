/** Carts for the Carts pages: the D1 index each CartAgent writes, and the flows that can price one. */

import { CART_STATUSES, type CartStatus, quoteNodes } from '@orderloop/core';
import { carts } from '@orderloop/db';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from './env.server';
import { publishedFlowGraphs } from './orders.server';

export const isCartStatus = (v: unknown): v is CartStatus =>
  CART_STATUSES.includes(v as CartStatus);

/** The newest carts first; staff carts only unless `external`. */
export async function listCarts(
  { status, external = false }: { status?: CartStatus; external?: boolean },
  limit = 200,
) {
  const where: SQL[] = [];
  if (status) where.push(eq(carts.status, status));
  if (!external) where.push(isNull(carts.pluginId));
  return db()
    .select()
    .from(carts)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(carts.updatedAt))
    .limit(limit);
}

/** Published flows a cart can be priced by and submitted to: they have a Price lines step. */
export async function cartFlows() {
  return (await publishedFlowGraphs())
    .filter((f) => quoteNodes(f.graph).some((n) => n.type === 'commerce.price'))
    .map(({ id, name, model }) => ({ id, name, model }));
}
