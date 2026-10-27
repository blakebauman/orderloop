import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type CheckoutSession,
  type OrderInput,
  staticRegistry,
  validateGraph,
} from '@orderloop/core';
import {
  createDb,
  customers,
  publishFlow,
  reservations,
  shipments,
  taxCertificates,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compensateOrder, retryLabelVoids } from '../../src/connectors';
import { startOrder } from '../../src/orders';
import { pluginUsage, registry } from '../../src/plugins';
import { quoteCheckout } from '../../src/ucp/quote';
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

  it('tells the tax provider of the customer’s exemption certificate, and says exempt only when it does', async () => {
    const customerId = `cus_exempt_${crypto.randomUUID().slice(0, 6)}`;
    await db()
      .insert(customers)
      .values({ id: customerId, name: 'Exempt Co', email: `${customerId}@example.com` });
    const now = Date.now() - 60_000;
    await db()
      .insert(taxCertificates)
      .values({
        id: `txc_${customerId.replace(/\W/g, '')}`,
        customerId,
        number: 'US-EXEMPT-1',
        regions: JSON.stringify([{ country: 'US' }]),
        createdBy: 'ops@example.com',
        createdById: 'usr_ops',
        createdAt: now,
        verifiedBy: 'checker@example.com',
        verifiedAt: now,
      });
    const { done } = await run('test-providers', { customerId });
    expect(done.status).toBe('completed');
    // The carrier taxes a US ship-to 10%, unless the certificate it was sent covers it.
    expect(done.order!.tax).toBe(0);
    expect(done.nodes.tax!.summary).toMatch(
      /^Tax exempt \(certificate on file\) · total .* \(fixture-carrier\)$/,
    );
    expect(done.nodes.tax!.output).toMatchObject({
      provider: CARRIER,
      exemption: { certificateId: `txc_${customerId.replace(/\W/g, '')}`, exempted: true },
    });

    // A provider that charges tax anyway: the order is taxed, and says nothing of an exemption.
    const ignored = await run('test-providers', {
      customerId,
      meta: { shipTo, simulate: 'ignore_exemption' },
    });
    expect(ignored.done.order!.tax).toBe(Math.round((ignored.done.order!.subtotal + 5) * 10) / 100);
    expect(ignored.done.nodes.tax!.summary).toMatch(/^Tax \$.* \(fixture-carrier\)$/);
    expect(ignored.done.nodes.tax!.output).toMatchObject({ exemption: { exempted: false } });
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

  it('keeps a label it can’t void on rollback, rolls the rest back, and voids it later', async () => {
    const { orderId, done } = await run('test-providers-fail', {
      meta: { shipTo, simulate: 'void_fails' },
    });
    expect(done.status).toBe('rolled_back');
    expect(done.nodes.ship!.summary).toMatch(/1 labels could not be voided with their provider/);
    // The saga went on: the stock it held is released.
    const held = await db().select().from(reservations).where(eq(reservations.orderId, orderId));
    expect(held.map((r) => r.status)).not.toContain('held');
    const rows = () => db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect((await rows()).map((r) => r.status)).toEqual(['void_failed']);
    expect((await pluginUsage(env, CARRIER)).labels).toEqual([
      { id: (await rows())[0]!.id, orderId },
    ]);

    // The carrier accepts the void again: the daily retry voids it.
    await testEnv.CARRIER_DB.prepare('UPDATE labels SET fail_void = 0 WHERE order_id = ?')
      .bind(orderId)
      .run();
    expect(await retryLabelVoids(env)).toMatchObject({ voided: 1 });
    expect((await rows()).map((r) => r.status)).toEqual(['cancelled']);
    expect((await labels(orderId)).map((l) => l.voided)).toEqual([1]);
    expect((await pluginUsage(env, CARRIER)).labels).toEqual([]);
  });

  it('cancels an order whose label can’t be voided, and says so', async () => {
    const { orderId } = await run('test-providers', { meta: { shipTo, simulate: 'void_fails' } });
    expect(await compensateOrder(env, orderId)).toMatchObject({ labelsNotVoided: 1 });
    const rows = await db().select().from(shipments).where(eq(shipments.orderId, orderId));
    expect(rows.map((r) => r.status)).toEqual(['void_failed']);
  });

  it('voids labels for packages it wasn’t asked about and fails the node', async () => {
    const { orderId, done } = await run('test-providers', {
      meta: { shipTo, simulate: 'label_wrong_ref' },
    });
    expect(done.status).toBe('rolled_back');
    expect(done.nodes.ship!.error).toMatch(/returned no label for shp_/);
    expect((await labels(orderId)).map((l) => l.voided)).toEqual([1]);
  });

  it('falls back to the static rates when the provider is down', async () => {
    const { done } = await run('test-providers', {
      meta: { shipTo, simulate: 'provider_down' },
    });
    expect(done.status).toBe('completed');
    expect(done.order!.shippingOption).toBe('standard');
    expect(done.nodes.rates!.summary).toMatch(/\(fixture-carrier unavailable\)$/);
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

  it('prices a checkout with the same providers, and keeps their errors from the agent', async () => {
    const session = (id: string): CheckoutSession => ({
      id,
      ownerId: 'platform',
      status: 'incomplete',
      currency: 'USD',
      lines: [{ id: 'li_1', sku: 'WID-100', qty: 2 }],
      buyer: { email: 'buyer@example.com' },
      fulfillment: 'ship',
      shipTo,
      shippingOption: null,
      quote: null,
      issues: [],
      orderId: null,
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
      version: 1,
    });
    const flow = (provider: string) => ({
      ...providerFlow('quote', 'completed', provider),
      version: 1,
      publishedAt: 0,
    });
    const { quote } = await quoteCheckout(env, flow(CARRIER) as never, session('chk_1'));
    expect(quote).toMatchObject({ shipping: 5 });
    expect(quote!.tax).toBe(Math.round((quote!.subtotal + 5) * 10) / 100);

    // "example" provides nothing: the agent hears a fixed message, not the provider's error.
    const failed = await quoteCheckout(env, flow('example') as never, session('chk_2'));
    expect(failed.quote).toBeNull();
    expect(failed.issues.map((i) => i.content)).toContainEqual(
      expect.stringMatching(/^Shipping or tax could not be calculated right now\.$/),
    );
  });
});
