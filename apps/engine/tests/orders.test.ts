import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type ChatMessage, type OrderInput, type OrderState, verifyWebhook } from '@orderloop/core';
import {
  approvals,
  createDb,
  orders,
  payments,
  products,
  reservations,
  shipments,
  webhookDeliveries,
  webhookSubscriptions,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copilotHeuristic } from '../src/ai';
import { refund } from '../src/connectors';
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
    (s) => ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'].includes(s.status),
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
    expect(done.status).toBe('declined');
    expect(done.nodes.reserve!.status).toBe('skipped');
    const decided = await db().select().from(approvals).where(eq(approvals.orderId, orderId)).get();
    expect(decided).toMatchObject({ status: 'rejected', decidedBy: 'dana', note: 'Over limit' });
  });

  it('prepares chat approvals and cancels for a person to confirm, without acting', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        type: 'b2b_order',
        customerId: 'cus_contoso',
        lines: [{ sku: 'WID-200', qty: 100 }],
      }),
    });
    await waitingOn(orderId, (x) => x.waits.some((w) => w.kind === 'approval'), 'approval');

    // The DO stub types chat() loosely; the agent returns the assistant's ChatMessage.
    const approve = (await agent(orderId).chat('approve it')) as ChatMessage;
    expect(approve.proposal).toEqual({ kind: 'decide', nodeId: 'approval', decision: 'approved' });
    const cancel = (await agent(orderId).chat('cancel this order')) as ChatMessage;
    expect(cancel.proposal).toMatchObject({ kind: 'cancel' });

    // Nothing was decided or cancelled: the order still waits on the same approval.
    const s = await state(orderId);
    expect(s.status).toBe('waiting');
    expect(s.waits.map((w) => w.nodeId)).toEqual(['approval']);
    const pending = await db().select().from(approvals).where(eq(approvals.orderId, orderId));
    expect(pending).toMatchObject([{ status: 'pending' }]);
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

describe('storefront order', () => {
  const stock = async (sku: string) =>
    (await db().select().from(products).where(eq(products.sku, sku)).get())!.stock;

  it('ships and captures, then restocks and partially refunds a return', async () => {
    await introspect();
    const before = await stock('MON-27');
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'MON-27', qty: 2 }],
      }),
    });
    await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'return.requested'),
      'return window',
    );
    expect(await stock('MON-27')).toBe(before - 2);

    await agent(orderId).deliver('return.requested', { amount: 100, reason: 'Damaged box' });
    const labelled = await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'return.received'),
      'return received wait',
    );
    expect(labelled.vars.returnTracking).toMatch(/^UPSR\d{9}$/);

    await agent(orderId).deliver('return.received');
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.reason).toBe('Returned');
    expect(done.vars.refunded).toBe(100);
    expect(done.nodes.review!.status).toBe('skipped');
    expect(await stock('MON-27')).toBe(before);

    const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(pays.filter((p) => p.kind === 'refund').map((p) => p.amount)).toEqual([100]);
    const rma = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(rma.map((r) => r.status).sort()).toEqual(['label_created', 'return_label']);
  });

  it('cancels before authorizing when the store policy fails', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 12 }],
        meta: { shipTo: 'PO Box 42, Springfield' },
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('declined');
    expect(done.reason).toBe('Failed store policy');
    expect(done.vars.policyFailures).toEqual([
      'More than 10 of GSK-010',
      'Cannot ship to a PO box',
    ]);
    expect(done.nodes.authorize!.status).toBe('skipped');
    expect(await db().select().from(payments).where(eq(payments.orderId, orderId))).toEqual([]);
  });

  it('completes without a refund when the return window closes', async () => {
    await introspect(['window#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 3 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.done!.status).toBe('succeeded');
    expect(done.nodes.refund!.status).toBe('skipped');
  });

  it('refunds idempotently per step and never more than was captured', async () => {
    await introspect(['window#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 4 }],
      }),
    });
    const s = await settled(orderId);
    const order = s.order!;
    const first = await refund(env, order, 'manual#1', 10);
    expect(first).toMatchObject({ amount: 10, status: 'succeeded' });
    // A retried step returns the refund it already made.
    expect(await refund(env, order, 'manual#1', 10)).toMatchObject({ amount: 10 });
    const rest = await refund(env, order, 'manual#2');
    expect(rest.amount).toBe(Math.round((order.total - 10) * 100) / 100);
    expect(await refund(env, order, 'manual#3')).toMatchObject({ status: 'failed', amount: 0 });
    const refunds = (
      await db().select().from(payments).where(eq(payments.orderId, orderId))
    ).filter((p) => p.kind === 'refund');
    expect(refunds).toHaveLength(2);
  });
});

describe('idempotency', () => {
  it('returns the same order for a repeated key, even when requests race', async () => {
    await introspect(['window#1']);
    const req = {
      flowId: 'tpl-storefront-order',
      idempotencyKey: 'checkout-7f3a',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 5 }],
      }),
    };
    const [a, b] = await Promise.all([startOrder(env, req), startOrder(env, req)]);
    expect(a.orderId).toBe(b.orderId);
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
    expect(await startOrder(env, req)).toEqual({ orderId: a.orderId, replayed: true });
    const rows = await db().select().from(orders).where(eq(orders.idempotencyKey, 'checkout-7f3a'));
    expect(rows).toHaveLength(1);
    expect((await settled(a.orderId)).status).toBe('completed');
    // A different key is a different order.
    const c = await startOrder(env, { ...req, idempotencyKey: 'checkout-8b1c' });
    expect(c.orderId).not.toBe(a.orderId);
    await settled(c.orderId);
  });
});

describe('outbound webhooks', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db().delete(webhookSubscriptions);
  });

  const subscribe = (id: string, events: string[]) =>
    db()
      .insert(webhookSubscriptions)
      .values({
        id,
        url: `https://hooks.example/${id}`,
        secret: `whsec_${id}`,
        events: JSON.stringify(events),
        createdAt: Date.now(),
      });

  it('signs and delivers the events each subscription asked for', async () => {
    const received: { url: string; body: string; headers: Headers }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      received.push({
        url: String(url),
        body: String(init?.body),
        headers: new Headers(init?.headers),
      });
      return new Response('ok');
    });
    await subscribe('all', ['*']);
    await subscribe('ship', ['order.shipped']);
    await introspect(['window#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 5 }],
      }),
    });
    expect((await settled(orderId)).status).toBe('completed');

    const mine = received.filter((r) => JSON.parse(r.body).orderId === orderId);
    const events = (id: string) =>
      mine.filter((r) => r.url.endsWith(`/${id}`)).map((r) => JSON.parse(r.body).event);
    expect(events('all')).toEqual(['order.shipped', 'order.paid', 'order.completed']);
    expect(events('ship')).toEqual(['order.shipped']);

    for (const r of mine) {
      const id = r.url.split('/').pop()!;
      expect(
        await verifyWebhook(`whsec_${id}`, r.body, r.headers.get('x-orderloop-signature')),
      ).toEqual({ ok: true });
      expect(r.headers.get('x-orderloop-delivery')).toBe(JSON.parse(r.body).id);
    }
    const shipped = JSON.parse(mine.find((r) => r.url.endsWith('/ship'))!.body);
    expect(shipped.data.node.output.tracking).toMatch(/^UPS/);
    const rows = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.orderId, orderId));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === 'delivered' && r.attempts === 1)).toBe(true);
  });

  it('retries a failing endpoint, then gives up without failing the order', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('no', { status: 503 }),
    );
    await subscribe('down', ['order.completed']);
    await introspect(['window#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        type: 'storefront_order',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 5 }],
      }),
    });
    expect((await settled(orderId)).status).toBe('completed');
    const [row] = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.orderId, orderId));
    expect(row).toMatchObject({ event: 'order.completed', status: 'failed', responseStatus: 503 });
    expect(row!.attempts).toBe(6);
  });

  const capture = () => {
    const received: { event: string; orderId: string; data: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      received.push(JSON.parse(String(init?.body)));
      return new Response('ok');
    });
    return received;
  };

  it('announces an order cancelled from the UI or API', async () => {
    const received = capture();
    await subscribe('all', ['*']);
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
    await waitingOn(orderId, (x) => x.waits.some((w) => w.nodeId === 'mgr'), 'manager approval');
    await agent(orderId).cancel('Duplicate request');

    const cancelled = await until(
      async () => received.find((r) => r.orderId === orderId && r.event === 'order.cancelled'),
      'order.cancelled delivery',
    );
    expect(cancelled.data).toMatchObject({
      outcome: 'cancelled',
      reason: 'Duplicate request',
      order: { id: orderId, type: 'purchase_request' },
    });
    // A repeat cancel is a no-op and sends nothing more.
    await agent(orderId).cancel('again');
    const rows = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.orderId, orderId));
    expect(rows.map((r) => [r.event, r.status])).toEqual([['order.cancelled', 'delivered']]);
  });

  it('announces an order that fails because a node threw', async () => {
    const received = capture();
    await subscribe('failures', ['order.failed']);
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        type: 'b2b_order',
        customerId: 'cus_northwind',
        lines: [{ sku: 'NOPE-404', qty: 1 }],
      }),
    });
    await waitingOn(orderId, (s) => s.status === 'failed', 'failure');

    const failed = await until(async () => {
      const mine = received.filter((r) => r.orderId === orderId);
      return mine.length ? mine : false;
    }, 'order.failed delivery');
    expect(failed.map((r) => r.event)).toEqual(['order.failed']);
    expect(failed[0]!.data).toMatchObject({
      outcome: 'failed',
      order: { id: orderId },
      node: { id: 'validate', type: 'commerce.validate' },
    });
    expect(String(failed[0]!.data.reason)).toContain('Unknown SKUs: NOPE-404');
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
