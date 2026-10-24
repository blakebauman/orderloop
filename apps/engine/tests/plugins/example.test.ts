import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { validateGraph } from '@orderloop/core';
import { createDb, publishFlow, reservations, webhookDeliveries } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { execPluginNode, registry } from '../../src/plugins';
import { node, settled, stampFlow, stampInput } from '../plugin-helpers';

const testEnv = env as Env & {
  EXAMPLE_DB: D1Database;
  TEST_EXAMPLE_MIGRATIONS: D1Migration[];
};
const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const stamps = async (orderId: string) =>
  (
    await testEnv.EXAMPLE_DB.prepare('SELECT step_key, note FROM stamps WHERE order_id = ?')
      .bind(orderId)
      .all<{ step_key: string; note: string }>()
  ).results;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
async function introspect() {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.EXAMPLE_DB, testEnv.TEST_EXAMPLE_MIGRATIONS);
  await ensureTemplates(env);
  await publishFlow(db(), stampFlow('test-stamp', 'completed'));
  await publishFlow(db(), stampFlow('test-stamp-fails', 'failed'));
  await publishFlow(db(), stampFlow('test-stamp-skips', 'completed', true));
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('an installed plugin', () => {
  it('lists its manifest and passes the deep health check', async () => {
    const [m] = await api().pluginCatalog();
    expect(m).toMatchObject({ id: 'example', events: ['order.completed'] });
    expect(m!.nodes.map((n) => n.type)).toEqual(['example.stamp']);
    expect((await api().health()).checks).toMatchObject({ plugin_example: 'ok' });
  });

  it('makes its nodes valid in a flow', async () => {
    const flow = stampFlow('x', 'completed');
    expect(validateGraph(flow, await registry(env)).errors).toEqual([]);
    expect(validateGraph(flow).errors[0]!.message).toBe('Plugin “example” is not installed');
  });

  it('runs its node in the order, and gets the events it subscribed to', async () => {
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-stamp', input: stampInput() });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.stamp).toMatchObject({ status: 'succeeded', summary: 'Stamped “hello”' });
    expect(await stamps(orderId)).toEqual([{ step_key: 'stamp#1', note: 'hello' }]);

    const delivered = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.orderId, orderId));
    expect(delivered).toMatchObject([
      { subscriptionId: 'plugin:example', event: 'order.completed', status: 'delivered' },
    ]);
    const received = await testEnv.EXAMPLE_DB.prepare(
      'SELECT id, event FROM deliveries WHERE order_id = ?',
    )
      .bind(orderId)
      .all();
    expect(received.results).toEqual([{ id: delivered[0]!.id, event: 'order.completed' }]);
  });

  it('follows the branch the plugin chose', async () => {
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-stamp-skips', input: stampInput() });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.reason).toBe('skipped');
    expect(await stamps(orderId)).toEqual([]);
  });

  it('writes once per step key when a step is retried', async () => {
    const ctx = {
      order: {
        ...stampInput(),
        id: 'ord_retry',
        createdAt: 0,
        subtotal: 0,
        shipping: 0,
        tax: 0,
        total: 0,
      },
      nodes: {},
      vars: {},
      input: {},
      now: 0,
      ref: 'ord_retry',
    };
    const exec = { env, node: node('stamp', 'example.stamp'), config: { note: 'again' }, ctx };
    await execPluginNode({ ...exec, stepKey: 'stamp#1' });
    await execPluginNode({ ...exec, stepKey: 'stamp#1' });
    expect(await stamps('ord_retry')).toEqual([{ step_key: 'stamp#1', note: 'again' }]);
  });

  it('compensates its node when the order fails after it', async () => {
    await introspect();
    const { orderId } = await startOrder(env, { flowId: 'test-stamp-fails', input: stampInput() });
    const done = await settled(orderId, 45_000);
    expect(done.status).toBe('rolled_back');
    expect(done.nodes.stamp!.status).toBe('rolled_back');
    expect(done.nodes.stamp!.summary).toBe('Removed the stamp');
    expect(done.nodes.reserve!.status).toBe('rolled_back');
    expect(await stamps(orderId)).toEqual([]);
  });

  it('reports what uses it', async () => {
    const usage = await api().pluginUsage('example');
    expect(usage.flows.map((f) => f.id).sort()).toEqual([
      'test-stamp',
      'test-stamp-fails',
      'test-stamp-skips',
    ]);
    expect(await api().pluginUsage('other')).toEqual({ flows: [], orders: [] });
  });

  it('leaves the stock it reserved for the order that completed', async () => {
    const held = await db().select().from(reservations);
    expect(held.length).toBeGreaterThan(0);
  });
});
