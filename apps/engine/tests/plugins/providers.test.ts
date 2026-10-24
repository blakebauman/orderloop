import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { type OrderInput, staticRegistry, validateGraph } from '@orderloop/core';
import { createDb, publishFlow, shipments } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compensateOrder } from '../../src/connectors';
import { startOrder } from '../../src/orders';
import { pluginUsage, registry } from '../../src/plugins';
import { edge, node, settled } from '../plugin-helpers';

const testEnv = env as Env & { CARRIER_DB: D1Database; TEST_CARRIER_MIGRATIONS: D1Migration[] };
const db = () => createDb(env.DB);
const CARRIER = 'fixture-carrier';
const shipTo = { line1: '1 Main St', city: 'Springfield', postalCode: '62701', country: 'US' };

/** start → reserve → price → rates → address → tax → ship → end, every provider the carrier. */
const providerFlow = (id: string, outcome: 'completed' | 'failed', provider = CARRIER) => ({
  id,
  name: 'Providers',
  description: '',
  model: 'b2b',
  channels: [],
  nodes: [
    node('start', 'trigger.manual'),
    node('reserve', 'commerce.reserve_inventory'),
    node('price', 'commerce.price'),
    node('rates', 'commerce.shipping_rate', { provider, select: 'cheapest' }),
    node('address', 'commerce.address_validate', { provider }),
    node('tax', 'commerce.tax', { provider }),
    node('ship', 'commerce.ship', { provider, carrier: 'ups' }),
    node('done', 'control.end', { outcome, reason: outcome }),
    node('bad', 'control.end', { outcome: 'failed', reason: 'address' }),
  ],
  edges: [
    edge('start', 'reserve'),
    edge('reserve', 'price', 'ok'),
    edge('price', 'rates'),
    edge('rates', 'address', 'ok'),
    edge('address', 'tax', 'valid'),
    edge('address', 'tax', 'corrected'),
    edge('address', 'bad', 'invalid'),
    edge('tax', 'ship'),
    edge('ship', 'done'),
  ],
});

const input = (over: Partial<OrderInput> = {}): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId: 'cus_northwind',
  lines: [{ sku: 'WID-100', qty: 2 }],
  meta: { shipTo },
  ...over,
});

const labels = async (orderId: string) =>
  (
    await testEnv.CARRIER_DB.prepare(
      'SELECT ref, kind, voided FROM labels WHERE order_id = ? ORDER BY ref',
    )
      .bind(orderId)
      .all<{ ref: string; kind: string; voided: number }>()
  ).results;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
async function run(flowId: string, over: Partial<OrderInput> = {}) {
  await introspector?.dispose();
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, { flowId, input: input(over) });
  return { orderId, done: await settled(orderId, 45_000) };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.CARRIER_DB, testEnv.TEST_CARRIER_MIGRATIONS);
  await publishFlow(db(), providerFlow('test-providers', 'completed'));
  await publishFlow(db(), providerFlow('test-providers-fail', 'failed'));
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('a plugin as provider', () => {
  it('rates, checks the address, taxes and labels the order', async () => {
    const { orderId, done } = await run('test-providers');
    expect(done.status).toBe('completed');
    // 2 × 24 for the customer's price list; Ground is 3 + 1 a unit; 10% on goods and shipping.
    expect(done.order).toMatchObject({ shippingOption: `${CARRIER}_ground`, shipping: 5 });
    expect(done.order!.tax).toBe(Math.round((done.order!.subtotal + 5) * 10) / 100);
    expect(done.nodes.rates!.summary).toMatch(/^Ground \(FIXTURE-CARRIER\)/);
    expect(done.nodes.address!.summary).toBe('Suggested a corrected address');
    expect(done.nodes.ship!.summary).toMatch(/^FIXTURE FX/);

    const rows = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(rows).toMatchObject([
      { provider: CARRIER, carrier: 'fixture', status: 'label_created' },
    ]);
    expect(rows[0]!.externalId).toMatch(/^fx_/);
    expect(await labels(orderId)).toEqual([{ ref: rows[0]!.id, kind: 'shipment', voided: 0 }]);
  });

  it('voids the label when the order fails after it', async () => {
    const { orderId, done } = await run('test-providers-fail');
    expect(done.status).toBe('rolled_back');
    expect(done.nodes.ship!.status).toBe('rolled_back');
    expect(done.nodes.ship!.summary).toMatch(/voided 1 labels/);
    expect((await labels(orderId)).map((l) => l.voided)).toEqual([1]);
    const rows = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(rows.map((r) => r.status)).toEqual(['cancelled']);
  });

  it('voids open labels when the order is cancelled', async () => {
    const { orderId } = await run('test-providers');
    const undone = await compensateOrder(env, orderId);
    expect(undone).toMatchObject({ cancelled: 1, labelsNotVoided: 0 });
    expect((await labels(orderId)).map((l) => l.voided)).toEqual([1]);
  });

  it('falls back to the static rates when the provider is down', async () => {
    const { done } = await run('test-providers', {
      meta: { shipTo, simulate: 'provider_down' },
    });
    expect(done.status).toBe('completed');
    expect(done.order!.shippingOption).toBe('standard');
    expect((done.nodes.rates as { output?: { source?: string } }).output?.source).toBe('static');
  });

  it('is checked when the flow is validated, and counted as using the plugin', async () => {
    const reg = await registry(env);
    expect(validateGraph(providerFlow('x', 'completed'), reg).errors).toEqual([]);
    expect(
      validateGraph(providerFlow('x', 'completed', 'example'), reg).errors.map((e) => e.message),
    ).toContain("rates: Provider: plugin “example” doesn't provide shipping rates");
    // Once the plugin is gone, the flow can't be published.
    expect(
      validateGraph(providerFlow('x', 'completed'), staticRegistry).errors.map((e) => e.message),
    ).toContain(`rates: Provider: plugin “${CARRIER}” is not installed`);
    const usage = await pluginUsage(env, CARRIER);
    expect(usage.flows.map((f) => f.id)).toEqual(
      expect.arrayContaining(['test-providers', 'test-providers-fail']),
    );
  });
});
