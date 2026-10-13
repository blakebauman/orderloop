import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderInput, OrderState } from '@orderloop/core';
import { approvals, createDb, orders, payments, reservations, shipments } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { copilotHeuristic } from '../src/ai';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';

const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string, ms?: number) =>
  until(
    async () => {
      const s = await state(id);
      return pred(s) ? s : false;
    },
    what,
    ms,
  );

const settled = (id: string) =>
  waitingOn(
    id,
    (s) => ['completed', 'cancelled', 'failed', 'rolled_back'].includes(s.status),
    'a terminal status',
  );

const input = (o: Partial<OrderInput> & Pick<OrderInput, 'type'>): OrderInput => ({
  currency: 'USD',
  lines: [],
  meta: {},
  ...o,
});

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await ensureTemplates(env);
});

async function introspect(timeouts: string[] = []) {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    for (const name of timeouts) await m.forceEventTimeout({ name });
  });
}

afterEach(async () => {
  await introspector?.dispose();
});

describe('B2B order', () => {
  it('extracts a PO, auto-approves, ships and completes on payment', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        type: 'b2b_order',
        customerId: 'cus_northwind',
        documentText:
          'From: Northwind Traders\nPO #NW-7781\nPlease send 50 x WID-100 and 20 x GSK-010.',
      }),
    });

    const waiting = await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'payment.received'),
      'payment wait',
    );
    expect(waiting.order!.lines.map((l) => [l.sku, l.qty, l.unitPrice])).toEqual([
      ['WID-100', 50, 21.5],
      ['GSK-010', 20, 7.25],
    ]);
    expect(waiting.order!.subtotal).toBe(1220);
    expect(waiting.nodes.router!.branches).toEqual(['auto_approve']);
    expect(waiting.nodes.approval!.status).toBe('skipped');
    expect(waiting.order!.documentKey).toMatch(/^orders\/ord_.*\/inbound\/po\.txt$/);

    expect(
      await agent(orderId).deliver('payment.received', { amount: waiting.order!.total }),
    ).toMatchObject({ delivered: true });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.done!.status).toBe('succeeded');

    const ship = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(ship).toHaveLength(1);
    const res = await db().select().from(reservations).where(eq(reservations.orderId, orderId));
    expect(res.every((r) => r.status === 'consumed')).toBe(true);
    const row = await db().select().from(orders).where(eq(orders.id, orderId)).get();
    expect(row!.status).toBe('completed');
  });

  it('asks for approval when over the credit limit, and declines on rejection', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        type: 'b2b_order',
        customerId: 'cus_contoso',
        lines: [{ sku: 'WID-200', qty: 100 }],
      }),
    });
    const s = await waitingOn(
      orderId,
      (x) => x.waits.some((w) => w.kind === 'approval'),
      'approval',
    );
    expect(s.nodes.credit!.branches).toEqual(['over_limit']);
    const pending = await db().select().from(approvals).where(eq(approvals.orderId, orderId));
    expect(pending).toMatchObject([{ status: 'pending', assignee: 'sales_ops' }]);

    await agent(orderId).decide('approval', 'rejected', 'dana', 'Over limit');
    const done = await settled(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.nodes.reserve!.status).toBe('skipped');
    const decided = await db().select().from(approvals).where(eq(approvals.orderId, orderId)).get();
    expect(decided).toMatchObject({ status: 'rejected', decidedBy: 'dana', note: 'Over limit' });
  });

  it('runs the dunning loop three times, then sends the invoice to collections', async () => {
    await introspect(['paid#1', 'paid_late#1', 'paid_late#2', 'paid_late#3']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        type: 'b2b_order',
        customerId: 'cus_fabrikam',
        lines: [{ sku: 'BRG-608', qty: 100 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.reason).toBe('Sent to collections');
    expect(done.nodes.remind!.runs).toBe(3);
    expect(done.nodes.dunning!.runs).toBe(4);
  });

  it('fails when stock is short and rolls back through the Workflow', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        type: 'b2b_order',
        customerId: 'cus_northwind',
        lines: [{ sku: 'WID-100', qty: 10 }],
        meta: { simulate: 'out_of_stock' },
      }),
    });
    const failed = await waitingOn(orderId, (s) => s.status === 'rolled_back', 'rollback', 45_000);
    expect(failed.reason).toContain('Insufficient stock');
    expect(failed.rollback).toEqual({ outcome: 'complete', error: null });
    expect(failed.nodes.reserve!.status).toBe('rolled_back');
  });
});

describe('cancel', () => {
  it('terminates a waiting purchase request and releases everything', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-purchase-request',
      input: input({
        type: 'purchase_request',
        customerId: 'cus_internal',
        title: 'Laptops',
        lines: [{ sku: 'LAP-14', qty: 8 }],
      }),
    });
    const s = await waitingOn(
      orderId,
      (x) => x.waits.some((w) => w.nodeId === 'mgr'),
      'manager approval',
    );
    expect(s.vars.category).toBe('it_hardware');
    await agent(orderId).cancel('Changed our mind');
    const done = await state(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.waits).toEqual([]);
    const a = await db().select().from(approvals).where(eq(approvals.orderId, orderId)).get();
    expect(a!.status).toBe('cancelled');
  });
});

describe('subscription', () => {
  it('pauses after the renewal and its retry both fail', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-subscription',
      input: input({
        type: 'subscription',
        customerId: 'cus_ada',
        lines: [{ sku: 'SUB-BOX', qty: 1 }],
        meta: { simulate: 'charge_fail' },
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.reason).toBe('Renewal payment failed');
    expect(done.nodes.fulfill!.status).toBe('skipped');
    const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(pays.map((p) => p.status).sort()).toEqual(['authorized', 'failed', 'failed']);
  });
});

describe('reorder', () => {
  it('forecasts low stock, gets approval, and restocks on receipt', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-reorder',
      input: input({ type: 'reorder', customerId: 'cus_internal' }),
    });
    const s = await waitingOn(
      orderId,
      (x) => x.waits.some((w) => w.kind === 'approval'),
      'buyer approval',
    );
    expect(s.order!.lines.map((l) => l.sku).sort()).toEqual(['MTR-750', 'WID-200']);
    expect(s.order!.total).toBeGreaterThan(10_000);
    await agent(orderId).decide('approval', 'approved', 'buyer');
    await waitingOn(
      orderId,
      (x) => x.waits.some((w) => w.event === 'supplier.ack'),
      'supplier ack',
    );
    await agent(orderId).deliver('supplier.ack');
    await waitingOn(orderId, (x) => x.waits.some((w) => w.event === 'goods.received'), 'receipt');
    await agent(orderId).deliver('goods.received');
    expect((await settled(orderId)).status).toBe('completed');
  });
});

describe('copilot (offline)', () => {
  it('inserts a node after another and keeps the graph valid', async () => {
    const { TEMPLATES, validateGraph } = await import('@orderloop/core');
    const flow = TEMPLATES.b2b_order();
    const { graph } = copilotHeuristic({
      prompt: 'add a fraud risk score after credit',
      graph: flow,
    });
    const risk = graph.nodes.find((n) => n.type === 'ai.risk_score')!;
    expect(graph.edges.some((e) => e.source === 'credit' && e.target === risk.id)).toBe(true);
    expect(validateGraph(graph).errors).toEqual([]);
  });
});
