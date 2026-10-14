import { createExecutionContext, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  encodePrincipal,
  type OrderInput,
  type OrderState,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  SESSION_IDLE_MS,
  type StartOrderOnceInput,
  verifyWebhook,
  withDefaults,
} from '@orderloop/core';
import {
  approvals,
  createDb,
  customers,
  entitlements,
  locationStock,
  messages,
  nodeRuns,
  orders,
  payments,
  payouts,
  priceSources,
  products,
  publishFlow,
  reservations,
  sellerOrders,
  sessions,
  shipments,
  stockMovements,
  users,
  webhookDeliveries,
  webhookSubscriptions,
} from '@orderloop/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copilotHeuristic, extractHeuristic } from '../src/ai';
import { EngineApi } from '../src/api';
import { resolveImages } from '../src/clef';
import { refund, reserveInventory, restock } from '../src/connectors';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { EXECUTORS } from '../src/nodes';
import { startOrder, startOrderOnce } from '../src/orders';

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

const input = (o: Partial<OrderInput> & Pick<OrderInput, 'model'>): OrderInput => ({
  channel: 'api',
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
  it('reads the sender from an email header, but not from a sentence', () => {
    expect(extractHeuristic('From: Northwind Traders\nSubject: PO #NW-7781').customerName).toBe(
      'Northwind Traders',
    );
    expect(extractHeuristic('from: Contoso Ltd\n').customerName).toBe('Contoso Ltd');
    expect(extractHeuristic('Please ship these from the warehouse.\n').customerName).toBeNull();
  });

  it('identifies the customer from the email alone, as the dashboard scenario sends it', async () => {
    await introspect();
    // The dashboard's "B2B PO by email" scenario: no customerId, just the email.
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        model: 'b2b',
        documentText:
          'From: Northwind Traders\nSubject: PO #NW-7781\n\nHi team, please ship 120 x WID-100 (industrial widgets), 40 x GSK-010 gasket kits and 8 x WID-200.\nDeliver to dock 4. Thanks, Priya — Purchasing',
      }),
    });
    const waiting = await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'payment.received'),
      'payment wait',
    );
    expect(waiting.order!.customerId).toBe('cus_northwind');
    expect(waiting.order!.title).toBe('PO NW-7781');
    expect(waiting.nodes.credit!.branches).toEqual(['ok']);
    expect(waiting.nodes.router!.branches).toEqual(['auto_approve']);
    expect(waiting.nodes.approval!.status).toBe('skipped');
  });

  it('extracts a PO, auto-approves, ships and completes on payment', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        model: 'b2b',
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
        model: 'b2b',
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

  it('runs the dunning loop three times, then sends the invoice to collections', async () => {
    await introspect(['paid#1', 'paid_late#1', 'paid_late#2', 'paid_late#3']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        model: 'b2b',
        customerId: 'cus_fabrikam',
        lines: [{ sku: 'BRG-608', qty: 100 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.reason).toBe('Sent to collections');
    expect(done.nodes.remind!.runs).toBe(3);
    expect(done.nodes.dunning!.runs).toBe(4);

    // Every finished run is timed once: executor steps, waits and each loop iteration.
    const rows = await db().select().from(nodeRuns).where(eq(nodeRuns.orderId, orderId));
    const runs = (id: string) =>
      rows
        .filter((r) => r.nodeId === id)
        .map((r) => r.run)
        .sort();
    expect(runs('remind')).toEqual([1, 2, 3]);
    expect(runs('paid_late')).toEqual([1, 2, 3]);
    expect(runs('price')).toEqual([1]);
    const late = rows.find((r) => r.nodeId === 'paid_late')!;
    expect(late).toMatchObject({
      nodeType: 'control.wait_event',
      model: 'b2b',
      status: 'succeeded',
    });
    expect(rows.every((r) => r.durationMs >= 0 && r.durationMs === r.endedAt - r.startedAt)).toBe(
      true,
    );
  });

  it('fails when stock is short and rolls back through the Workflow', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-b2b-order',
      input: input({
        model: 'b2b',
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
        model: 'procurement',
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

  it('tells the API what happened: unknown order, a step not waiting, an order already over', async () => {
    await introspect();
    const api = new EngineApi(createExecutionContext(), env);
    expect(await api.cancel('ord_doesnotexist', 'x')).toEqual({ ok: false, reason: 'not_found' });
    expect(await api.decide('ord_doesnotexist', 'mgr', 'approved', 'api')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await api.sendEvent('ord_doesnotexist', 'payment.received')).toEqual({
      delivered: false,
      notFound: true,
    });

    const { orderId } = await startOrder(env, {
      flowId: 'tpl-purchase-request',
      input: input({
        model: 'procurement',
        customerId: 'cus_internal',
        lines: [{ sku: 'LAP-14', qty: 8 }],
      }),
    });
    await waitingOn(orderId, (x) => x.waits.some((w) => w.nodeId === 'mgr'), 'manager approval');
    expect(await api.decide(orderId, 'fin', 'approved', 'api')).toEqual({
      ok: false,
      reason: 'not_waiting',
    });
    expect(await api.cancel(orderId, 'Changed our mind')).toEqual({ ok: true });
    expect(await api.cancel(orderId, 'Again')).toEqual({ ok: false, reason: 'finished' });
    expect(await api.intakeMailboxes()).toMatchObject({ orders: 'tpl-b2b-order' });
  });
});

describe('subscription', () => {
  it('pauses after the renewal and its retry both fail', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-subscription',
      input: input({
        model: 'subscription',
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
      input: input({ model: 'replenishment', customerId: 'cus_internal' }),
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
        model: 'b2c',
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

  it('restocks only the lines a partial return lists', async () => {
    await introspect();
    const before = { mon: await stock('MON-27'), gsk: await stock('GSK-010') };
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [
          { sku: 'MON-27', qty: 2 },
          { sku: 'GSK-010', qty: 5 },
        ],
      }),
    });
    await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'return.requested'),
      'return window',
    );
    // One monitor comes back; the gaskets and the other monitor stay with the customer.
    await agent(orderId).deliver('return.requested', {
      amount: 50,
      reason: 'One arrived cracked',
      lines: [{ sku: 'MON-27', qty: 1 }],
    });
    await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'return.received'),
      'return received wait',
    );
    await agent(orderId).deliver('return.received');
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.restock!.summary).toBe('+1 units');
    expect(await stock('MON-27')).toBe(before.mon - 1);
    expect(await stock('GSK-010')).toBe(before.gsk - 5);
  });

  it('cancels before authorizing when the store policy fails', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        model: 'b2c',
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
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 3 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.done!.status).toBe('succeeded');
    expect(done.nodes.refund!.status).toBe('skipped');
  });

  it('runs a guest checkout: emails go to the contact and nothing is billed on account', async () => {
    await introspect(['window#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        model: 'b2c',
        channel: 'web',
        contact: { email: 'sam.rivera@example.com', name: 'Sam Rivera' },
        lines: [{ sku: 'MON-27', qty: 1 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    const sent = await db().select().from(messages).where(eq(messages.orderId, orderId));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.recipient === 'sam.rivera@example.com')).toBe(true);
    const row = await db().select().from(orders).where(eq(orders.id, orderId)).get();
    expect(row).toMatchObject({ channel: 'web', contactEmail: 'sam.rivera@example.com' });
    // The flow's default source ("storefront") is not the order's, so it isn't shown.
    expect(done.nodes.checkout!.summary).toBe('Web');
  });

  it('starts from an inbound order keyed by channel and external id', async () => {
    await introspect(['window#1']);
    const { inboundFingerprint, inboundOrderSchema, toStartRequest } = await import(
      '@orderloop/core'
    );
    const inbound = inboundOrderSchema.parse({
      model: 'b2c',
      channel: 'mobile',
      externalId: 'app-5521',
      source: 'shopify',
      customerId: 'cus_ada',
      lines: [{ sku: 'MON-27', qty: 1 }],
    });
    const fingerprint = await inboundFingerprint(inbound);
    const req = { ...toStartRequest(inbound, 'tpl-storefront-order'), fingerprint };
    const first = await startOrderOnce(env, req);
    if ('mismatch' in first) throw new Error('A first start cannot mismatch');
    expect(await startOrderOnce(env, req)).toEqual({ orderId: first.orderId, replayed: true });
    // ORDER_ROUTES changed before the retry: it routes elsewhere but is still the same order.
    expect(
      await startOrderOnce(env, {
        ...toStartRequest(inbound, 'tpl-omnichannel-order'),
        fingerprint,
      }),
    ).toEqual({ orderId: first.orderId, replayed: true });
    // Different contents under the same channel and id are still refused.
    const changed = inboundOrderSchema.parse({ ...inbound, lines: [{ sku: 'MON-27', qty: 2 }] });
    expect(
      await startOrderOnce(env, {
        ...toStartRequest(changed, 'tpl-storefront-order'),
        fingerprint: await inboundFingerprint(changed),
      }),
    ).toEqual({ mismatch: true });
    const done = await settled(first.orderId);
    expect(done.nodes.checkout).toMatchObject({
      status: 'succeeded',
      summary: 'Mobile app · app-5521 (shopify)',
    });
    const row = await db().select().from(orders).where(eq(orders.id, first.orderId)).get();
    expect(row).toMatchObject({
      channel: 'mobile',
      externalId: 'app-5521',
      idempotencyKey: 'order:mobile:app-5521',
    });
  });

  it('runs orders mapped from Shopify and from an X12 850', async () => {
    await introspect(['window#1']);
    const { inboundOrderSchema, parseX12, shopifyToInbound, toStartRequest, x12850ToInbound } =
      await import('@orderloop/core');
    const fromShopify = shopifyToInbound({
      id: 5001,
      name: '#5001',
      email: 'ada@example.com',
      currency: 'USD',
      source_name: 'web',
      line_items: [{ sku: 'MON-27', title: 'Monitor', quantity: 1, price: '329.00' }],
    });
    if (!fromShopify.ok) throw new Error(fromShopify.error);
    const shop = await startOrder(
      env,
      toStartRequest(inboundOrderSchema.parse(fromShopify.order), 'tpl-storefront-order'),
    );
    const sold = await settled(shop.orderId);
    expect(sold.status).toBe('completed');
    // Shopify's price is kept, not replaced by the list price.
    expect(sold.order!.lines[0]!.unitPrice).toBe(329);
    expect(sold.nodes.checkout!.summary).toBe('Web · 5001 (shopify)');

    const x12 = parseX12(
      'ISA*00*          *00*          *ZZ*NORTHWIND      *ZZ*ORDERLOOP      *261014*1200*U*00401*000000001*0*P*>~' +
        'GS*PO*NORTHWIND*ORDERLOOP*20261014*1200*1*X*004010~ST*850*0001~BEG*00*SA*NW-9001**20261014~' +
        'PO1*1*10*EA*21.50**VP*WID-100~CTT*1~SE*5*0001~GE*1*1~IEA*1*000000001~',
    );
    if (!x12.ok) throw new Error(x12.error);
    const po = x12850ToInbound(x12.interchange.transactions[0]!, {
      sender: 'NORTHWIND',
      customerId: 'cus_northwind',
    });
    if (!po.ok) throw new Error(po.error);
    const b2b = await startOrder(
      env,
      toStartRequest(inboundOrderSchema.parse(po.order), 'tpl-b2b-order'),
    );
    const waiting = await waitingOn(
      b2b.orderId,
      (x) => x.waits.length > 0,
      'the B2B order to wait',
    );
    expect(waiting.order).toMatchObject({
      channel: 'edi',
      customerId: 'cus_northwind',
      title: 'PO NW-9001',
    });
    expect(waiting.nodes.po_in!.summary).toBe('EDI · NORTHWIND:NW-9001');
    expect(waiting.nodes.extract!.summary).toBe('No document; using order as given');
    expect(waiting.order!.lines).toEqual([
      expect.objectContaining({ sku: 'WID-100', qty: 10, unitPrice: 21.5 }),
    ]);
  });

  it('refunds idempotently per step and never more than was captured', async () => {
    await introspect(['window#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-storefront-order',
      input: input({
        model: 'b2c',
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

describe('marketplace order', () => {
  const lines = [
    { sku: 'HP-200', qty: 1 },
    { sku: 'KET-01', qty: 2 },
  ];
  const parts = async (orderId: string) =>
    Object.fromEntries(
      (await db().select().from(sellerOrders).where(eq(sellerOrders.orderId, orderId))).map((p) => [
        p.sellerId,
        p.status,
      ]),
    );
  const start = () =>
    startOrder(env, {
      flowId: 'tpl-marketplace-order',
      input: input({ model: 'marketplace', channel: 'marketplace', customerId: 'cus_ada', lines }),
    });
  const awaitingSeller = (orderId: string) =>
    waitingOn(orderId, (s) => s.waits.some((w) => w.event === 'seller.responded'), 'seller wait');

  it('waits for the seller that does not auto-accept, then pays both out net of commission', async () => {
    await introspect(['window#1']);
    const { orderId } = await start();
    await awaitingSeller(orderId);
    expect(await parts(orderId)).toEqual({ sel_brightside: 'accepted', sel_kettle: 'pending' });
    const asked = await db().select().from(messages).where(eq(messages.orderId, orderId));
    expect(asked.map((m) => m.recipient)).toEqual(['shop@kettleandco.example']);
    expect((await state(orderId)).nodes.ask!.summary).toMatch(/^→ 1 seller: New order /);

    await agent(orderId).deliver('seller.responded', {
      sellerId: 'sel_kettle',
      decision: 'accepted',
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(await parts(orderId)).toEqual({ sel_brightside: 'accepted', sel_kettle: 'accepted' });
    const out = await db().select().from(payouts).where(eq(payouts.orderId, orderId));
    expect(
      Object.fromEntries(out.map((p) => [p.sellerId, [p.gross, p.commission, p.net]])),
    ).toEqual({
      sel_brightside: [129, 15.48, 113.52],
      sel_kettle: [158, 23.7, 134.3],
    });
    expect(out.every((p) => p.status === 'scheduled')).toBe(true);
  });

  it('drops a rejecting seller’s lines and captures only what was accepted', async () => {
    await introspect(['window#1']);
    const { orderId } = await start();
    await awaitingSeller(orderId);
    await agent(orderId).deliver('seller.responded', {
      sellerId: 'sel_kettle',
      decision: 'rejected',
      reason: 'Out of the blue colour',
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.record!.summary).toBe('1 accepted, 1 rejected (Kettle & Co)');
    expect(done.order!.lines.map((l) => l.sku)).toEqual(['HP-200']);
    const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
    const auth = pays.find((p) => p.kind.startsWith('authorization'))!;
    const capture = pays.find((p) => p.kind === 'capture')!;
    expect(capture.amount).toBe(done.order!.total);
    expect(capture.amount).toBeLessThan(auth.amount);
    const out = await db().select().from(payouts).where(eq(payouts.orderId, orderId));
    expect(out.map((p) => p.sellerId)).toEqual(['sel_brightside']);
  });

  it('fails and voids the authorization when no seller accepts in time', async () => {
    await introspect(['responded#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-marketplace-order',
      input: input({
        model: 'marketplace',
        channel: 'marketplace',
        customerId: 'cus_ada',
        lines: [{ sku: 'KET-01', qty: 1 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    expect(done.nodes.no_sellers!.status).toBe('succeeded');
    expect(await parts(orderId)).toEqual({ sel_kettle: 'rejected' });
    // The void is a rollback: Workflows runs it after the run fails, so it can land after the
    // `failed` report `settled` waits for.
    const pays = await until(async () => {
      const rows = await db().select().from(payments).where(eq(payments.orderId, orderId));
      return rows.length > 0 && rows.every((p) => p.status === 'voided') && rows;
    }, 'the void');
    expect(pays.map((p) => p.status)).toEqual(['voided']);
  });

  it('cancels seller orders when the order fails after the split', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-marketplace-order',
      input: input({
        model: 'marketplace',
        channel: 'marketplace',
        customerId: 'cus_ada',
        lines: [{ sku: 'HP-200', qty: 1 }],
        meta: { simulate: 'out_of_stock' },
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    // Cancelling the seller order is a rollback too, so it can land after the `failed` report.
    await until(async () => (await parts(orderId)).sel_brightside === 'cancelled', 'the cancel');
    expect(await parts(orderId)).toEqual({ sel_brightside: 'cancelled' });
  });
});

describe('omnichannel and point of sale', () => {
  const storeStock = async (locationId: string, sku: string) => {
    const r = await db()
      .select()
      .from(locationStock)
      .where(and(eq(locationStock.locationId, locationId), eq(locationStock.sku, sku)))
      .get();
    return { stock: r!.stock, reserved: r!.reserved };
  };
  const central = async (sku: string) =>
    (await db().select().from(products).where(eq(products.sku, sku)).get())!.stock;
  const omni = (o: Partial<OrderInput>) =>
    startOrder(env, {
      flowId: 'tpl-omnichannel-order',
      input: input({ model: 'd2c', channel: 'web', customerId: 'cus_ada', ...o }),
    });

  it('holds stock at the pickup store, then hands it over when collected', async () => {
    await introspect();
    const before = await storeStock('loc_soho', 'MON-27');
    const { orderId } = await omni({
      lines: [{ sku: 'MON-27', qty: 1 }],
      fulfillment: { method: 'pickup', locationId: 'loc_soho' },
    });
    const ready = await waitingOn(
      orderId,
      (s) => s.waits.some((w) => w.event === 'pickup.collected'),
      'pickup wait',
    );
    expect(ready.vars.pickupCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(await storeStock('loc_soho', 'MON-27')).toEqual({
      stock: before.stock,
      reserved: before.reserved + 1,
    });
    await agent(orderId).deliver('pickup.collected', {});
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(await storeStock('loc_soho', 'MON-27')).toEqual({
      stock: before.stock - 1,
      reserved: before.reserved,
    });
    const ships = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(ships.map((s) => [s.carrier, s.status])).toEqual([['pickup', 'collected']]);
  });

  it('releases the store’s stock and voids payment when a pickup is not collected', async () => {
    await introspect(['collect#1']);
    const before = await storeStock('loc_soho', 'MON-27');
    const { orderId } = await omni({
      lines: [{ sku: 'MON-27', qty: 2 }],
      fulfillment: { method: 'pickup', locationId: 'loc_soho' },
    });
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    expect(done.nodes.uncollected!.status).toBe('succeeded');
    // Releasing, cancelling and voiding are rollbacks, which can land after the `failed` report.
    await until(async () => {
      const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
      const ships = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
      const stock = await storeStock('loc_soho', 'MON-27');
      return (
        pays.every((p) => p.status === 'voided') &&
        ships.every((s) => s.status === 'cancelled') &&
        stock.reserved === before.reserved
      );
    }, 'the rollback');
    expect(await storeStock('loc_soho', 'MON-27')).toEqual(before);
    const ships = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(ships.map((s) => s.status)).toEqual(['cancelled']);
    const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(pays.map((p) => p.status)).toEqual(['voided']);
  });

  it('ships from a store when the warehouse has none, and delivers a mixed cart’s codes', async () => {
    await introspect();
    const before = await storeStock('loc_soho', 'TEE-01');
    expect(await central('TEE-01')).toBe(0);
    const { orderId } = await omni({
      lines: [
        { sku: 'TEE-01', qty: 2 },
        { sku: 'EBK-101', qty: 1 },
      ],
      meta: {
        shipTo: {
          line1: '200 Lafayette St',
          city: 'New York',
          region: 'NY',
          postalCode: '10012',
          country: 'US',
          latitude: 40.7215,
          longitude: -73.9977,
        },
      },
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.route!.summary).toBe('Ship from SoHo store + digital');
    expect(done.order!.fulfillment).toEqual({ method: 'ship', locationId: 'loc_soho' });
    expect((await storeStock('loc_soho', 'TEE-01')).stock).toBe(before.stock - 2);
    const codes = await db().select().from(entitlements).where(eq(entitlements.orderId, orderId));
    expect(codes.map((c) => [c.sku, c.status])).toEqual([['EBK-101', 'issued']]);
    const capture = (await db().select().from(payments).where(eq(payments.orderId, orderId))).find(
      (p) => p.kind === 'capture',
    )!;
    expect(capture.amount).toBe(done.order!.total);
  });

  it('ships from the store nearest the customer', async () => {
    await introspect();
    const before = await storeStock('loc_mission', 'TEE-01');
    const { orderId } = await omni({
      lines: [{ sku: 'TEE-01', qty: 1 }],
      meta: {
        shipTo: {
          line1: '1 Market St',
          city: 'San Francisco',
          region: 'CA',
          postalCode: '94105',
          country: 'US',
          latitude: 37.7946,
          longitude: -122.3947,
        },
      },
    });
    const done = await settled(orderId);
    expect(done.nodes.route!.summary).toBe('Ship from Mission store');
    expect((await storeStock('loc_mission', 'TEE-01')).stock).toBe(before.stock - 1);
  });

  it('splits a shipment across the warehouse and the nearest store when no one place has it all', async () => {
    await introspect();
    const tees = await storeStock('loc_mission', 'TEE-01');
    const monitors = await central('MON-27');
    const { orderId } = await omni({
      lines: [
        { sku: 'MON-27', qty: 8 },
        { sku: 'TEE-01', qty: 3 },
      ],
      meta: {
        shipTo: {
          line1: '1 Market St',
          city: 'San Francisco',
          region: 'CA',
          postalCode: '94105',
          country: 'US',
          latitude: 37.7946,
          longitude: -122.3947,
        },
      },
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.route!.summary).toBe('Ship from Warehouse and Mission store');
    expect(done.order!.lines.map((l) => [l.sku, l.locationId ?? null])).toEqual([
      ['MON-27', null],
      ['TEE-01', 'loc_mission'],
    ]);
    expect(done.nodes.ship!.summary).toMatch(/^2 UPS shipments: UPS\d+, UPS\d+$/);
    const ships = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(ships.map((s) => s.status)).toEqual(['label_created', 'label_created']);
    expect(await central('MON-27')).toBe(monitors - 8);
    expect((await storeStock('loc_mission', 'TEE-01')).stock).toBe(tees.stock - 3);
  });

  it('revokes delivered codes when the physical part cannot be fulfilled', async () => {
    await introspect();
    const { orderId } = await omni({
      lines: [
        { sku: 'TEE-01', qty: 500 },
        { sku: 'GFT-25', qty: 2 },
      ],
    });
    const done = await settled(orderId);
    expect(done.status).toBe('failed');
    // Revoking is a rollback, so it can land after the `failed` report.
    const codes = await until(async () => {
      const rows = await db().select().from(entitlements).where(eq(entitlements.orderId, orderId));
      return rows.length === 2 && rows.every((c) => c.status === 'revoked') && rows;
    }, 'the revoke');
    expect(codes.map((c) => c.status)).toEqual(['revoked', 'revoked']);
  });

  it('sells at the till from the store’s stock and emails a receipt', async () => {
    await introspect();
    const before = await storeStock('loc_mission', 'TEE-01');
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-pos-sale',
      input: input({
        model: 'b2c',
        channel: 'pos',
        contact: { email: 'walk.in@example.com' },
        fulfillment: { method: 'carry_out', locationId: 'loc_mission' },
        lines: [{ sku: 'TEE-01', qty: 1 }],
      }),
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.handover!.summary).toBe('Carried out');
    expect(await storeStock('loc_mission', 'TEE-01')).toEqual({
      stock: before.stock - 1,
      reserved: before.reserved,
    });
    const sent = await db().select().from(messages).where(eq(messages.orderId, orderId));
    expect(sent.map((m) => m.recipient)).toEqual(['walk.in@example.com']);
    const pays = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(pays.map((p) => p.kind).sort()).toEqual(['authorization:card_present', 'capture']);
  });
});

describe('address validation', () => {
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    label: id,
    config,
    position: { x: 0, y: 0 },
  });
  const edge = (source: string, target: string, sourceHandle: string | null = null) => ({
    id: `${source}.${sourceHandle ?? 'out'}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle: null,
  });

  beforeAll(async () => {
    await publishFlow(db(), {
      id: 'test-address',
      name: 'Address check',
      description: '',
      model: 'b2c',
      channels: [],
      nodes: [
        node('start', 'trigger.manual'),
        node('address', 'commerce.address_validate'),
        node('ok', 'control.end', { outcome: 'completed', reason: 'valid' }),
        node('fixed', 'control.end', { outcome: 'completed', reason: 'corrected' }),
        node('bad', 'control.end', { outcome: 'declined', reason: 'invalid' }),
      ],
      edges: [
        edge('start', 'address'),
        edge('address', 'ok', 'valid'),
        edge('address', 'fixed', 'corrected'),
        edge('address', 'bad', 'invalid'),
      ],
    });
  });

  const run = async (shipTo: unknown) => {
    const { orderId } = await startOrder(env, {
      flowId: 'test-address',
      input: input({
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 1 }],
        meta: { shipTo },
      }),
    });
    return settled(orderId);
  };

  it('branches on the check and suggests a corrected address', async () => {
    await introspect();
    const valid = await run({
      line1: '1 Main St',
      city: 'Springfield',
      region: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    expect([valid.status, valid.reason]).toEqual(['completed', 'valid']);
    expect(valid.vars.suggestedAddress).toBeUndefined();

    const fixed = await run({
      line1: '1 Main St',
      city: 'Springfield',
      region: 'Illinois',
      postalCode: '62701',
      country: 'usa',
    });
    expect(fixed.reason).toBe('corrected');
    expect(fixed.vars.suggestedAddress).toMatchObject({ region: 'IL', country: 'US' });

    const bad = await run('PO Box 9, Springfield');
    expect([bad.status, bad.reason]).toEqual(['declined', 'invalid']);
    expect(bad.nodes.address!.summary).toMatch(/free text/);
  });
});

describe('pricing chain', () => {
  const price = async (
    customerId: string,
    lines: OrderInput['lines'],
    config: Record<string, unknown> = {},
    currency = 'USD',
  ) => {
    const order = {
      ...input({ model: 'b2b', customerId, lines, currency }),
      id: 'ord_pricing',
      createdAt: Date.now(),
      subtotal: 0,
      tax: 0,
      total: 0,
    };
    const node = {
      id: 'price',
      type: 'commerce.price',
      label: 'Price',
      config: {},
      position: { x: 0, y: 0 },
    };
    const r = await EXECUTORS['commerce.price']!({
      env,
      node,
      config: withDefaults('commerce.price', config),
      ctx: { order, nodes: {}, vars: {}, input: {}, now: Date.now() },
      stepKey: 'price#1',
    });
    return {
      ...(r.output as {
        subtotal: number;
        fxRate: number;
        lines: { sku: string; unitPrice: number; by: string; rule: string }[];
      }),
      order: r.order!,
    };
  };

  it('prices each line from the first source that matches, in priority order', async () => {
    // Fabrikam is silver: the price book (priority 10) beats list price for WID-200, and its
    // contract (priority 20) prices MTR-750.
    const fab = await price('cus_fabrikam', [
      { sku: 'WID-200', qty: 10 },
      { sku: 'MTR-750', qty: 1 },
    ]);
    expect(fab.lines.map((l) => [l.sku, l.unitPrice, l.by])).toEqual([
      ['WID-200', 55, 'price_book'],
      ['MTR-750', 389, 'contract'],
    ]);
    // Northwind's contract stops the chain before the cheaper-looking volume tier...
    const nw = await price('cus_northwind', [{ sku: 'WID-100', qty: 600 }]);
    expect(nw.lines[0]).toMatchObject({ unitPrice: 21.5, by: 'contract' });
    // ...Contoso has no contract, so 600 widgets reach the 8% volume tier.
    const co = await price('cus_contoso', [
      { sku: 'WID-100', qty: 600 },
      { sku: 'WID-100', qty: 10 },
    ]);
    expect(co.lines.map((l) => [l.unitPrice, l.by, l.rule])).toEqual([
      [22.08, 'volume', 'Industrial widget, 500+'],
      [24, 'list', 'List price'],
    ]);
  });

  it('prices an order in its own currency at the stored rate', async () => {
    // Northwind's contract is 21.50 USD; at 0.92 EUR per USD that is 19.78 EUR.
    const eur = await price('cus_northwind', [{ sku: 'WID-100', qty: 600 }], {}, 'EUR');
    expect(eur.fxRate).toBe(0.92);
    expect(eur.lines[0]).toMatchObject({ unitPrice: 19.78, by: 'contract' });
    expect(eur.order).toMatchObject({ fxRate: 0.92, subtotal: 11868, baseTotal: 12900 });
    // A price given on the order is already in the order's currency.
    const given = await price(
      'cus_northwind',
      [{ sku: 'WID-100', qty: 1, unitPrice: 20 }],
      {},
      'EUR',
    );
    expect(given.lines[0]!.unitPrice).toBe(20);
    await expect(price('cus_northwind', [{ sku: 'WID-100', qty: 1 }], {}, 'JPY')).rejects.toThrow(
      'No exchange rate for JPY',
    );
  });

  it('checks credit in the base currency', async () => {
    // 100,000 limit and 12,000 balance: 88,000 USD available.
    await db()
      .insert(customers)
      .values({
        id: 'cus_fx',
        name: 'FX test',
        email: 'fx@example.com',
        tier: 'standard',
        creditLimit: 100_000,
        balance: 12_000,
        terms: 'net_30',
      })
      .onConflictDoNothing();
    const check = (total: number, currency: string, fxRate: number) =>
      EXECUTORS['commerce.credit_check']!({
        env,
        node: {
          id: 'credit',
          type: 'commerce.credit_check',
          label: 'Credit',
          config: {},
          position: { x: 0, y: 0 },
        },
        config: {},
        ctx: {
          order: {
            ...input({ model: 'b2b', customerId: 'cus_fx', currency }),
            id: 'ord_credit',
            createdAt: 0,
            subtotal: total,
            tax: 0,
            total,
            fxRate,
            baseTotal: Math.round((total / fxRate) * 100) / 100,
          },
          nodes: {},
          vars: {},
          input: {},
          now: Date.now(),
        },
        stepKey: 'credit#1',
      });
    expect((await check(85_000, 'USD', 1)).branches).toEqual(['ok']);
    // 85,000 GBP is 107,594.94 USD: 19,594.94 over, reported in pounds.
    const gbp = await check(85_000, 'GBP', 0.79);
    expect(gbp.branches).toEqual(['over_limit']);
    expect(gbp.summary).toBe('Over limit by £15,480.00');
  });

  const run = (
    type: string,
    config: Record<string, unknown>,
    order: Partial<OrderInput>,
    total = 500,
  ) =>
    EXECUTORS[type]!({
      env,
      node: { id: 'n', type, label: type, config, position: { x: 0, y: 0 } },
      config: withDefaults(type, config),
      ctx: {
        order: {
          ...input({ model: 'b2c', ...order }),
          id: `ord_${type.replace('.', '_')}_${order.customerId ?? 'guest'}`,
          createdAt: 0,
          subtotal: total,
          tax: 0,
          total,
          fxRate: 1,
          baseTotal: total,
        },
        nodes: {},
        vars: {},
        input: {},
        now: Date.now(),
      },
      stepKey: 'n#1',
    });

  it('sends guests and consumers to the no-account branch of a credit check', async () => {
    const guest = await run('commerce.credit_check', {}, { contact: { email: 'g@example.com' } });
    expect(guest).toMatchObject({
      branches: ['over_limit'],
      summary: 'Guest checkout (no credit account)',
    });
    const consumer = await run(
      'commerce.credit_check',
      { noAccount: 'ok' },
      { customerId: 'cus_ada' },
    );
    expect(consumer).toMatchObject({ branches: ['ok'], summary: 'No credit account (consumer)' });
  });

  it('bills only unpaid business invoices on account', async () => {
    const balance = async (id: string) =>
      (await db().select().from(customers).where(eq(customers.id, id)).get())!.balance;
    const fabrikam = await balance('cus_fabrikam');
    const owed = await run(
      'commerce.invoice',
      { terms: 'net_30' },
      { model: 'b2b', customerId: 'cus_fabrikam' },
    );
    expect(owed.output).toMatchObject({ terms: 'net_30', onAccount: true });
    expect(await balance('cus_fabrikam')).toBe(fabrikam + 500);
    // A retried step (same order and step key) bills the account once.
    await run(
      'commerce.invoice',
      { terms: 'net_30' },
      { model: 'b2b', customerId: 'cus_fabrikam' },
    );
    expect(await balance('cus_fabrikam')).toBe(fabrikam + 500);

    const off = await run(
      'commerce.invoice',
      { onAccount: false },
      { model: 'b2b', customerId: 'cus_fabrikam' },
    );
    expect(off.output).toMatchObject({ terms: 'due_on_receipt', onAccount: false });
    const ada = await balance('cus_ada');
    const consumer = await run('commerce.invoice', {}, { customerId: 'cus_ada' });
    expect(consumer.output).toMatchObject({ onAccount: false });
    expect(await balance('cus_ada')).toBe(ada);
    expect(await balance('cus_fabrikam')).toBe(fabrikam + 500);
  });

  it('switches sources off per node and keeps given prices', async () => {
    const off = await price('cus_northwind', [{ sku: 'WID-100', qty: 600 }], {
      useContracts: false,
    });
    expect(off.lines[0]).toMatchObject({ unitPrice: 22.08, by: 'volume' });
    const none = await price('cus_northwind', [{ sku: 'WID-100', qty: 600 }], {
      useContracts: false,
      usePriceRules: false,
    });
    expect(none.lines[0]).toMatchObject({ unitPrice: 24, by: 'list' });
    const given = await price('cus_northwind', [{ sku: 'WID-100', qty: 600, unitPrice: 20 }]);
    expect(given.lines[0]).toMatchObject({ unitPrice: 20, rule: 'Given on the order' });
  });

  it('follows the sources table: reordering it changes the outcome', async () => {
    await db().update(priceSources).set({ priority: 5 }).where(eq(priceSources.id, 'volume'));
    try {
      const nw = await price('cus_northwind', [{ sku: 'WID-100', qty: 600 }]);
      // Volume runs first but doesn't stop, so the contract is still a candidate and is lower.
      expect(nw.lines[0]).toMatchObject({ unitPrice: 21.5, by: 'contract' });
      await db().update(priceSources).set({ active: false }).where(eq(priceSources.id, 'contract'));
      const noContract = await price('cus_northwind', [{ sku: 'WID-100', qty: 600 }]);
      expect(noContract.lines[0]).toMatchObject({ unitPrice: 22.08, by: 'volume' });
    } finally {
      await db().update(priceSources).set({ priority: 30 }).where(eq(priceSources.id, 'volume'));
      await db().update(priceSources).set({ active: true }).where(eq(priceSources.id, 'contract'));
    }
  });
});

describe('agent socket roles', () => {
  /** Opens the order page's socket the way the web proxy does, as `principal`. */
  const socket = async (orderId: string, principal: ProxiedPrincipal | null) => {
    const headers = new Headers({ Upgrade: 'websocket' });
    if (principal) headers.set(PRINCIPAL_HEADER, encodePrincipal(principal));
    const res = await worker.fetch(
      new Request(`http://engine/agents/order-agent/${orderId}`, { headers }),
      env,
    );
    const ws = res.webSocket!;
    ws.accept();
    const pending = new Map<string, (m: { success: boolean; error?: string }) => void>();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
    });
    let n = 0;
    return {
      call: (method: string, args: unknown[]) =>
        new Promise<{ success: boolean; error?: string }>((resolve) => {
          const id = `c${++n}`;
          pending.set(id, resolve);
          ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
        }),
      close: () => ws.close(),
    };
  };
  /** A person with a live session, as the web proxy describes them. */
  const who = async (role: Principal['role'], email: string): Promise<ProxiedPrincipal> => {
    const id = `usr_${email.split('@')[0]}`;
    const session = `sess_${id}`;
    await db()
      .insert(users)
      .values({ id, email, name: email.split('@')[0]!, role, createdAt: Date.now() })
      .onConflictDoUpdate({ target: users.id, set: { role, disabledAt: null } });
    await db()
      .insert(sessions)
      .values({
        tokenHash: session,
        userId: id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      })
      .onConflictDoNothing();
    return { kind: 'user', id, name: email.split('@')[0]!, email, role, session };
  };

  it('checks the caller role on the socket and records who decided', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-purchase-request',
      input: input({
        model: 'procurement',
        customerId: 'cus_internal',
        title: 'Laptops',
        lines: [{ sku: 'LAP-14', qty: 8 }],
      }),
    });
    await waitingOn(orderId, (x) => x.waits.some((w) => w.nodeId === 'mgr'), 'manager approval');

    const viewer = await socket(orderId, await who('viewer', 'vee@example.com'));
    expect(await viewer.call('decide', ['mgr', 'approved', 'boss@example.com'])).toMatchObject({
      success: false,
      error: 'This needs the Approver role.',
    });
    expect((await viewer.call('cancel', ['nope'])).error).toBe('This needs the Operator role.');
    viewer.close();
    // A socket with no principal (not opened through the web proxy) can't act either.
    const anonymous = await socket(orderId, null);
    expect((await anonymous.call('decide', ['mgr', 'approved'])).success).toBe(false);
    anonymous.close();
    expect((await state(orderId)).waits.some((w) => w.nodeId === 'mgr')).toBe(true);

    // An approver decides, and the record names them, not what the page claimed.
    const approver = await socket(orderId, await who('approver', 'ann@example.com'));
    expect(await approver.call('decide', ['mgr', 'approved', 'boss@example.com'])).toMatchObject({
      success: true,
    });
    approver.close();
    const row = await until(async () => {
      const a = await db().select().from(approvals).where(eq(approvals.orderId, orderId)).get();
      return a?.status === 'approved' ? a : false;
    }, 'the approval to close');
    expect(row.decidedBy).toBe('ann@example.com');
    // RPC from the web app's own routes is trusted and keeps its `by`.
    await agent(orderId).cancel('Cleanup');
    expect((await state(orderId)).status).toBe('cancelled');
  });

  it('applies role changes, disabling and sign-out to a page that is already open', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-purchase-request',
      input: input({
        model: 'procurement',
        customerId: 'cus_internal',
        title: 'Monitors',
        lines: [{ sku: 'LAP-14', qty: 8 }],
      }),
    });
    await waitingOn(orderId, (x) => x.waits.some((w) => w.nodeId === 'mgr'), 'manager approval');

    // Opened as an approver, then demoted: the open page gets the new role.
    const pat = await who('approver', 'pat@example.com');
    const page = await socket(orderId, pat);
    expect((await page.call('whoami', [])).success).toBe(true);
    await db().update(users).set({ role: 'viewer' }).where(eq(users.id, pat.id));
    expect(await page.call('decide', ['mgr', 'approved'])).toMatchObject({
      success: false,
      error: 'This needs the Approver role.',
    });
    // Disabled: the session no longer counts, so even reading through the socket stops.
    await db().update(users).set({ disabledAt: Date.now() }).where(eq(users.id, pat.id));
    expect(await page.call('whoami', [])).toMatchObject({
      success: false,
      error: 'Your sign-in has ended. Reload the page to sign in again.',
    });
    page.close();

    // Signed out elsewhere (the session row is gone): refused the same way.
    const sam = await who('operator', 'sam@example.com');
    const other = await socket(orderId, sam);
    await db().delete(sessions).where(eq(sessions.tokenHash, sam.session!));
    expect((await other.call('cancel', ['nope'])).success).toBe(false);
    other.close();
    // A forged session id can't stand in for a real one.
    const forged = await socket(orderId, { ...sam, session: 'made-up' });
    expect((await forged.call('whoami', [])).success).toBe(false);
    forged.close();
    expect((await state(orderId)).waits.some((w) => w.nodeId === 'mgr')).toBe(true);
    await agent(orderId).cancel('Cleanup');
  });

  it('ends an idle session and counts socket calls as activity', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'tpl-purchase-request',
      input: input({
        model: 'procurement',
        customerId: 'cus_internal',
        title: 'Chairs',
        lines: [{ sku: 'LAP-14', qty: 8 }],
      }),
    });
    await waitingOn(orderId, (x) => x.waits.some((w) => w.nodeId === 'mgr'), 'manager approval');
    const kim = await who('viewer', 'kim@example.com');
    const seen = async () =>
      (await db().select().from(sessions).where(eq(sessions.tokenHash, kim.session!)).get())!
        .lastSeenAt;

    // Last seen 10 minutes ago: a call works and moves last-seen forward.
    await db()
      .update(sessions)
      .set({ lastSeenAt: Date.now() - 10 * 60_000 })
      .where(eq(sessions.tokenHash, kim.session!));
    const page = await socket(orderId, kim);
    expect((await page.call('whoami', [])).success).toBe(true);
    expect(Date.now() - (await seen())!).toBeLessThan(60_000);

    // Idle for longer than the limit: refused, although the session hasn't reached its expiry.
    await db()
      .update(sessions)
      .set({ lastSeenAt: Date.now() - SESSION_IDLE_MS - 1 })
      .where(eq(sessions.tokenHash, kim.session!));
    expect(await page.call('whoami', [])).toMatchObject({
      success: false,
      error: 'Your sign-in has ended. Reload the page to sign in again.',
    });
    page.close();
    await agent(orderId).cancel('Cleanup');
  });
});

describe('inventory', () => {
  const product = async (sku: string) =>
    (await db().select().from(products).where(eq(products.sku, sku)).get())!;
  const order = (id: string, lines: OrderInput['lines']) => ({
    ...input({ model: 'b2c', customerId: 'cus_ada' }),
    id,
    createdAt: Date.now(),
    subtotal: 0,
    tax: 0,
    total: 0,
    lines,
  });
  const two = [
    { sku: 'GSK-010', qty: 2 },
    { sku: 'GSK-010', qty: 3 },
  ];

  it('keeps reservations per order and line, and holds stock once per step', async () => {
    const before = (await product('GSK-010')).reserved;
    // Two orders run the same flow, so their reserve steps share a step key.
    await reserveInventory(env, order('ord_inv_a', two), 'reserve#1');
    await reserveInventory(env, order('ord_inv_b', two), 'reserve#1');
    const held = await db().select().from(reservations).where(eq(reservations.sku, 'GSK-010'));
    const mine = held.filter((r) => r.orderId === 'ord_inv_a' || r.orderId === 'ord_inv_b');
    expect(mine.map((r) => [r.orderId, r.qty]).sort()).toEqual([
      ['ord_inv_a', 2],
      ['ord_inv_a', 3],
      ['ord_inv_b', 2],
      ['ord_inv_b', 3],
    ]);
    expect((await product('GSK-010')).reserved).toBe(before + 10);
    // A retried step holds nothing more, and a later run (a loop) keeps the first hold.
    await reserveInventory(env, order('ord_inv_a', two), 'reserve#1');
    await reserveInventory(env, order('ord_inv_a', two), 'reserve#2');
    expect((await product('GSK-010')).reserved).toBe(before + 10);
  });

  it('finishes a reserve step that died after holding some lines', async () => {
    const before = (await product('GSK-010')).reserved;
    await reserveInventory(env, order('ord_inv_c', two), 'reserve#1');
    // Each line is one atomic batch, so a crash leaves a line wholly held or not at all: undo
    // the second line as if the step had died before it.
    const [, second] = await db()
      .select()
      .from(reservations)
      .where(eq(reservations.orderId, 'ord_inv_c'))
      .orderBy(reservations.id);
    await db().delete(reservations).where(eq(reservations.id, second!.id));
    await db().delete(stockMovements).where(eq(stockMovements.id, second!.id));
    await db()
      .update(products)
      .set({ reserved: before + 2 })
      .where(eq(products.sku, 'GSK-010'));

    const r = await reserveInventory(env, order('ord_inv_c', two), 'reserve#1');
    expect(r.short).toEqual([]);
    expect(r.reservationIds).toHaveLength(2);
    expect((await product('GSK-010')).reserved).toBe(before + 5);
  });

  it('restocks once per step and line', async () => {
    const before = (await product('MON-27')).stock;
    const lines = [{ sku: 'MON-27', qty: 1 }];
    await restock(env, 'ord_inv_d', 'restock#1', lines);
    await restock(env, 'ord_inv_d', 'restock#1', lines);
    expect((await product('MON-27')).stock).toBe(before + 1);
    // A second return on another step is a separate movement.
    await restock(env, 'ord_inv_d', 'restock#2', lines);
    expect((await product('MON-27')).stock).toBe(before + 2);
    const moves = await db()
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.orderId, 'ord_inv_d'));
    expect(moves.map((m) => [m.kind, m.qty, m.applied])).toEqual([
      ['restock', 1, true],
      ['restock', 1, true],
    ]);
  });
});

describe('idempotency', () => {
  const once = async (req: StartOrderOnceInput) => {
    const r = await startOrderOnce(env, req);
    if ('mismatch' in r) throw new Error(`Idempotency mismatch for ${req.idempotencyKey}`);
    return r;
  };

  it('returns the same order for a repeated key, even when requests race', async () => {
    await introspect(['window#1']);
    const req = {
      flowId: 'tpl-storefront-order',
      idempotencyKey: 'checkout-7f3a',
      input: input({
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 5 }],
      }),
    };
    const [a, b] = await Promise.all([once(req), once(req)]);
    expect(a.orderId).toBe(b.orderId);
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
    expect(await once(req)).toEqual({ orderId: a.orderId, replayed: true });
    const rows = await db().select().from(orders).where(eq(orders.idempotencyKey, 'checkout-7f3a'));
    expect(rows).toHaveLength(1);
    expect((await settled(a.orderId)).status).toBe('completed');
    // A different key is a different order.
    const c = await once({ ...req, idempotencyKey: 'checkout-8b1c' });
    expect(c.orderId).not.toBe(a.orderId);
    await settled(c.orderId);
  });

  it('refuses a repeated key with a different request, ignoring property order', async () => {
    await introspect(['window#1']);
    const req: StartOrderOnceInput = {
      flowId: 'tpl-storefront-order',
      idempotencyKey: 'checkout-9d2e',
      input: input({
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 5 }],
      }),
    };
    const a = await once(req);
    // Same request, keys in another order: still a replay.
    const reordered: StartOrderOnceInput = {
      input: Object.fromEntries(Object.entries(req.input).reverse()) as OrderInput,
      idempotencyKey: req.idempotencyKey,
      flowId: req.flowId,
    };
    expect(await once(reordered)).toEqual({ orderId: a.orderId, replayed: true });
    // A different quantity under the same key is refused and starts nothing.
    expect(
      await startOrderOnce(env, {
        ...req,
        input: { ...req.input, lines: [{ sku: 'GSK-010', qty: 6 }] },
      }),
    ).toEqual({ mismatch: true });
    const rows = await db().select().from(orders).where(eq(orders.idempotencyKey, 'checkout-9d2e'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    await settled(a.orderId);
  });

  it('finishes starting an order whose first request failed after the insert', async () => {
    await introspect(['window#1']);
    // What a request leaves behind when it dies between the insert and the Workflow create.
    const orderId = 'ord_halfstarted1';
    const now = Date.now();
    await db()
      .insert(orders)
      .values({
        id: orderId,
        model: 'b2c',
        status: 'queued',
        title: '',
        flowId: 'tpl-storefront-order',
        flowVersion: 1,
        instanceId: `${orderId}-g1`,
        generation: 1,
        customerId: 'cus_ada',
        currency: 'USD',
        total: 0,
        createdAt: now,
        updatedAt: now,
        idempotencyKey: 'checkout-half',
      });
    const req = {
      flowId: 'tpl-storefront-order',
      idempotencyKey: 'checkout-half',
      input: input({
        model: 'b2c',
        customerId: 'cus_ada',
        lines: [{ sku: 'GSK-010', qty: 5 }],
      }),
    };
    expect(await once(req)).toEqual({ orderId, replayed: true });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.order!.createdAt).toBe(now);
    // Once running, a replay only returns it.
    expect(await once(req)).toEqual({ orderId, replayed: true });
    expect(
      (await state(orderId)).timeline.filter(
        (t) => t.kind === 'order' && t.message.startsWith('Order created'),
      ),
    ).toHaveLength(1);
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
        model: 'b2c',
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
        model: 'b2c',
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
        model: 'procurement',
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
      order: { id: orderId, model: 'procurement' },
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
        model: 'b2b',
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
    const flow = TEMPLATES['tpl-b2b-order']();
    const { graph } = copilotHeuristic({
      prompt: 'add a fraud risk score after credit',
      graph: flow,
    });
    const risk = graph.nodes.find((n) => n.type === 'ai.risk_score')!;
    expect(graph.edges.some((e) => e.source === 'credit' && e.target === risk.id)).toBe(true);
    expect(validateGraph(graph).errors).toEqual([]);
  });
});

describe('assess', () => {
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    label: id,
    config,
    position: { x: 0, y: 0 },
  });
  const edge = (source: string, target: string, sourceHandle: string | null = null) => ({
    id: `${source}.${sourceHandle ?? 'out'}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle: null,
  });
  const questions = {
    handling: {
      type: 'choice',
      instructions: 'How should this order be packed?',
      criteria: { gift_wrap: 'Wrap it as a birthday gift', standard: 'Ship in a plain box' },
    },
    fragile: { type: 'noul', instructions: 'Is anything fragile?' },
  };
  const assessNode = (config: Record<string, unknown>) => ({
    id: 'assess',
    type: 'ai.assess',
    label: 'Assess',
    config,
    position: { x: 0, y: 0 },
  });
  const order = (id: string) => ({
    ...input({ model: 'b2c', meta: { note: 'Birthday gift for my sister' } }),
    id,
    createdAt: 0,
    subtotal: 0,
    tax: 0,
    total: 0,
  });
  const exec = (id: string, config: Record<string, unknown>) =>
    EXECUTORS['ai.assess']!({
      env,
      node: assessNode(config),
      config: withDefaults('ai.assess', config),
      ctx: { order: order(id), nodes: {}, vars: {}, input: {}, now: Date.now() },
      stepKey: 'assess#1',
    });

  beforeAll(async () => {
    await publishFlow(db(), {
      id: 'test-assess',
      name: 'Assess',
      description: '',
      model: 'b2c',
      channels: [],
      nodes: [
        node('start', 'trigger.manual'),
        node('assess', 'ai.assess', { questions, branchOn: 'handling', images: [] }),
        node('gift', 'control.end', { outcome: 'completed', reason: 'gift' }),
        node('plain', 'control.end', { outcome: 'completed', reason: 'plain' }),
      ],
      edges: [
        edge('start', 'assess'),
        edge('assess', 'gift', 'gift_wrap'),
        edge('assess', 'plain', 'standard'),
      ],
    });
  });

  it('branches on the chosen option and stores every answer', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-assess',
      input: input({ model: 'b2c', meta: { note: 'Birthday gift for my sister' } }),
    });
    const s = await settled(orderId);
    expect([s.status, s.reason]).toEqual(['completed', 'gift']);
    expect(s.nodes.plain!.status).toBe('skipped');
    const answers = s.vars.assessment as Record<string, Record<string, unknown>>;
    expect(answers.handling).toMatchObject({ type: 'choice', choice: 'gift_wrap' });
    expect(answers.fragile).toEqual({ type: 'noul', noul: 0.5 });
  });

  it('takes “unsure” below the confidence floor', async () => {
    const r = await exec('ord_unsure', { questions, branchOn: 'handling', minConfidence: 0.9 });
    expect(r.branches).toEqual(['unsure']);
    const sure = await exec('ord_sure', { questions, branchOn: 'handling', minConfidence: 0.5 });
    expect(sure.branches).toEqual(['gift_wrap']);
  });

  it('embeds images from the order’s documents, https and data URLs, and skips the rest', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const b64 = btoa(String.fromCharCode(...png));
    const put = (key: string, type = 'image/png') =>
      env.DOCS.put(key, png, { httpMetadata: { contentType: type } });
    await put('orders/ord_img/photo/a.png');
    await put('orders/ord_img/photo/notes.txt', 'text/plain');
    await put('orders/ord_other/photo/b.png');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
      );
    try {
      const { images, notes } = await resolveImages(
        env,
        [
          'orders/ord_img/photo/a.png',
          'orders/ord_img/photo/notes.txt',
          'orders/ord_other/photo/b.png',
          'http://example.com/c.png',
          'https://example.com/d.png',
          `data:image/png;base64,${b64}`,
          'https://example.com/e.png',
          'https://example.com/f.png',
        ],
        'ord_img',
      );
      expect(images).toHaveLength(4);
      expect(images[0]).toEqual({ content_type: 'image/png', base64: b64 });
      expect(notes).toEqual([
        'orders/ord_img/photo/notes.txt: text/plain is not PNG, JPEG or WebP',
        "orders/ord_other/photo/b.png: not one of this order's documents",
        'http://example.com/c.png: only https, data URLs or R2 keys',
        'Only the first 4 images are used',
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reads image references from the run context', async () => {
    await env.DOCS.put('orders/ord_ctx/photo/a.png', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    const r = await EXECUTORS['ai.assess']!({
      env,
      node: assessNode({}),
      config: withDefaults('ai.assess', { images: ['{{order.meta.photos}}'] }),
      ctx: {
        order: { ...order('ord_ctx'), meta: { photos: ['orders/ord_ctx/photo/a.png'] } },
        nodes: {},
        vars: {},
        input: {},
        now: Date.now(),
      },
      stepKey: 'assess#1',
    });
    expect(r.output).toMatchObject({ images: 1, notes: [], source: 'heuristic' });
    expect(Object.keys(r.vars!.assessment as object)).toEqual(['route', 'urgent', 'damage']);
  });
});
