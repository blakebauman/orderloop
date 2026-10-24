import {
  type FlowVersion,
  newId,
  type Order,
  orderInputSchema,
  type StartOrderInput,
  type StartOrderOnceInput,
  type StartOrderOnceResult,
  type StartOrderResult,
  startFingerprint,
  withoutSimulation,
} from '@orderloop/core';
import { createDb, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { storeDocument } from './connectors';
import { loadFlowVersion } from './flows';
import { orderAgent } from './namespaces';
import type { OrderLoopParams } from './workflow';

/** Creates the order row, initialises its OrderAgent and starts generation 1 of its Workflow. */
export async function startOrder(env: Env, req: StartOrderInput): Promise<StartOrderResult> {
  // Without a key there is nothing to replay, so there is never a mismatch.
  return (await start(env, req)) as StartOrderResult;
}

/**
 * Starts an order at most once per idempotency key. The row is inserted first, so the unique index
 * decides which of two concurrent requests creates the order; the other gets the existing order
 * back. Every step after the insert is safe to repeat, so a replay of an order whose start failed
 * part-way finishes it. A replay must match the original request's fingerprint, or it is refused.
 */
export function startOrderOnce(env: Env, req: StartOrderOnceInput): Promise<StartOrderOnceResult> {
  const { idempotencyKey, fingerprint, ...request } = req;
  return start(env, request, idempotencyKey, fingerprint);
}

async function start(
  env: Env,
  asked: StartOrderInput,
  key?: string,
  given?: string,
): Promise<StartOrderOnceResult> {
  // Every way in (the web app, the REST API, inbound orders, email, A2A, UCP) starts here, so a
  // simulated failure can't reach a deployment that doesn't allow them, whoever asks.
  const req =
    String(env.SIMULATE_FAILURES) === 'true'
      ? asked
      : { ...asked, input: withoutSimulation(asked.input) };
  const db = createDb(env.DB);
  const fingerprint = key ? (given ?? (await startFingerprint(req))) : null;
  const existing = async () =>
    key
      ? await db
          .select({
            id: orders.id,
            status: orders.status,
            flowId: orders.flowId,
            flowVersion: orders.flowVersion,
            instanceId: orders.instanceId,
            createdAt: orders.createdAt,
            fingerprint: orders.idempotencyFingerprint,
          })
          .from(orders)
          .where(eq(orders.idempotencyKey, key))
          .get()
      : undefined;
  const replay = async (
    row: NonNullable<Awaited<ReturnType<typeof existing>>>,
  ): Promise<StartOrderOnceResult> => {
    if (row.fingerprint && row.fingerprint !== fingerprint) return { mismatch: true };
    // Still queued with no Workflow: the first request failed after the insert.
    if (
      row.status === 'queued' &&
      !(await instanceExists(env, row.instanceId ?? instanceIdFor(row.id)))
    ) {
      const flow = await loadFlowVersion(env, row.flowId, row.flowVersion);
      if (!flow) throw new Error(`Flow ${row.flowId} v${row.flowVersion} not found`);
      await launch(env, req, flow, row.id, row.createdAt);
    }
    return { orderId: row.id, replayed: true };
  };
  const prior = await existing();
  if (prior) return replay(prior);

  const flow = await loadFlowVersion(env, req.flowId, req.version);
  if (!flow) throw new Error(`Flow ${req.flowId} has no published version`);
  const input = orderInputSchema.parse(req.input);
  const orderId = newId('ord');
  const now = Date.now();
  try {
    await db.insert(orders).values({
      id: orderId,
      model: input.model,
      channel: input.channel,
      externalId: input.externalId ?? null,
      contactEmail: input.contact?.email ?? null,
      status: 'queued',
      title: input.title ?? '',
      flowId: flow.id,
      flowVersion: flow.version,
      instanceId: instanceIdFor(orderId),
      generation: 1,
      customerId: input.customerId ?? null,
      currency: input.currency,
      total: 0,
      createdAt: now,
      updatedAt: now,
      idempotencyKey: key ?? null,
      idempotencyFingerprint: fingerprint,
      startedBy: req.startedBy ?? null,
    });
  } catch (err) {
    const raced = await existing();
    if (raced) return replay(raced);
    throw err;
  }
  await launch(env, req, flow, orderId, now);
  return { orderId };
}

const instanceIdFor = (orderId: string) => `${orderId}-g1`;

/** Stores the inbound document, initialises the agent and creates the Workflow; all repeatable. */
async function launch(
  env: Env,
  req: StartOrderInput,
  flow: FlowVersion,
  orderId: string,
  createdAt: number,
) {
  const input = orderInputSchema.parse(req.input);
  const order: Order = {
    ...input,
    id: orderId,
    createdAt,
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
  };
  const instanceId = instanceIdFor(orderId);
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
  // Once the document is in R2, the agent's state and the Workflow's params carry only its key
  // (`ai.extract` reads it back from there).
  if (order.documentKey) delete order.documentText;
  await orderAgent(env, orderId).init(order, flow, instanceId);
  const params: OrderLoopParams = {
    orderId,
    flowId: flow.id,
    version: flow.version,
    generation: 1,
    order,
    vars: req.vars ?? {},
  };
  try {
    await env.ORDER_LOOP.create({ id: instanceId, params });
  } catch (err) {
    // A concurrent replay created it first.
    if (!(await instanceExists(env, instanceId))) throw err;
  }
}

export async function instanceExists(env: Env, id: string) {
  try {
    await env.ORDER_LOOP.get(id);
    return true;
  } catch {
    return false;
  }
}
