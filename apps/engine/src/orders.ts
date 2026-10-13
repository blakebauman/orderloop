import {
  newId,
  type Order,
  orderInputSchema,
  type StartOrderInput,
  type StartOrderResult,
} from '@orderloop/core';
import { createDb, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { storeDocument } from './connectors';
import { loadFlowVersion } from './flows';
import type { OrderLoopParams } from './workflow';

/**
 * Creates the order row, initialises its OrderAgent and starts generation 1 of its Workflow.
 * With an idempotency key the row is inserted first, so the unique index decides which of two
 * concurrent requests creates the order; the other gets the existing order back.
 */
export async function startOrder(env: Env, req: StartOrderInput): Promise<StartOrderResult> {
  const db = createDb(env.DB);
  const key = req.idempotencyKey;
  const existing = async () =>
    key
      ? await db.select({ id: orders.id }).from(orders).where(eq(orders.idempotencyKey, key)).get()
      : undefined;
  const prior = await existing();
  if (prior) return { orderId: prior.id, replayed: true };

  const flow = await loadFlowVersion(env, req.flowId, req.version);
  if (!flow) throw new Error(`Flow ${req.flowId} has no published version`);
  const input = orderInputSchema.parse(req.input);
  const orderId = newId('ord');
  const now = Date.now();
  const order: Order = { ...input, id: orderId, createdAt: now, subtotal: 0, tax: 0, total: 0 };
  const instanceId = `${orderId}-g1`;
  try {
    await db.insert(orders).values({
      id: orderId,
      type: order.type,
      status: 'queued',
      title: order.title ?? '',
      flowId: flow.id,
      flowVersion: flow.version,
      instanceId,
      generation: 1,
      customerId: order.customerId ?? null,
      currency: order.currency,
      total: 0,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: key ?? null,
    });
  } catch (err) {
    const raced = await existing();
    if (raced) return { orderId: raced.id, replayed: true };
    throw err;
  }
  if (input.documentText && !input.documentKey) {
    order.documentKey = await storeDocument(
      env,
      orderId,
      'inbound',
      'po.txt',
      input.documentText,
      'text/plain; charset=utf-8',
    );
  }
  await env.ORDER_AGENT.getByName(orderId).init(order, flow, instanceId);
  const params: OrderLoopParams = {
    orderId,
    flowId: flow.id,
    version: flow.version,
    generation: 1,
    order,
    vars: req.vars ?? {},
  };
  await env.ORDER_LOOP.create({ id: instanceId, params });
  return { orderId };
}
