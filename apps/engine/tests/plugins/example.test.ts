import { applyD1Migrations, introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { type OrderInput, type OrderState, validateGraph } from '@orderloop/core';
import { createDb, publishFlow, reservations, webhookDeliveries } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import { startOrder } from '../../src/orders';
import { execPluginNode, pluginStatuses, registry } from '../../src/plugins';
import { node, probeFlow, settled, stampFlow, stampInput } from '../plugin-helpers';

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
  for (const behave of ['echo', 'fail', 'fail_retry', 'big', 'bad_branch', 'vars'])
    await publishFlow(db(), probeFlow(`test-probe-${behave}`, behave));
});

const probe = async (behave: string, input: Partial<OrderInput> = {}) => {
  await introspector?.dispose();
  await introspect();
  const { orderId } = await startOrder(env, {
    flowId: `test-probe-${behave}`,
    input: { ...stampInput(), lines: [], ...input },
  });
  return settled(orderId, 45_000, { rollback: false });
};
const attempts = (s: OrderState) => s.timeline.filter((t) => /attempt \d/.test(t.message)).length;

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('an installed plugin', () => {
  it('lists its manifest and passes the deep health check', async () => {
    const [s] = await api().pluginCatalog();
    expect(s).toMatchObject({ binding: 'PLUGIN_EXAMPLE', healthy: true });
    expect(s!.manifest).toMatchObject({ id: 'example', apiVersion: 1, personalData: 'redact' });
    expect(s!.manifest!.nodes.map((n) => n.type)).toEqual(['example.stamp', 'example.probe']);
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
    expect(usage.flows.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'test-stamp',
        'test-stamp-fails',
        'test-stamp-skips',
        'test-probe-echo',
      ]),
    );
    expect(await api().pluginUsage('other')).toEqual({ flows: [], orders: [] });
  });

  it('leaves the stock it reserved for the order that completed', async () => {
    const held = await db().select().from(reservations);
    expect(held.length).toBeGreaterThan(0);
  });
});

describe('what the engine accepts from a plugin', () => {
  it('sends it the order without the buyer details its manifest did not ask for', async () => {
    const done = await probe('echo', {
      contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
      meta: { shipTo: { line1: '1 Main St', city: 'Springfield' } },
    });
    expect(done.status).toBe('completed');
    const sent = done.nodes.probe!.output as { order: Record<string, unknown> };
    expect(sent.order).not.toHaveProperty('contact');
    expect(JSON.stringify(sent)).not.toMatch(/ada|main st/i);
  });

  it('keeps its variables under its own name', async () => {
    const done = await probe('vars');
    expect(done.vars).toMatchObject({ example: { probed: true } });
    expect(done.vars).not.toHaveProperty('probed');
  });

  it('fails the node without retrying for fail, an oversized result or a branch it lacks', async () => {
    for (const [behave, reason] of [
      ['fail', 'Probe declined'],
      ['big', 'output is'],
      ['bad_branch', 'chose “elsewhere”'],
    ] as const) {
      const done = await probe(behave);
      expect(done.status, behave).toBe('failed');
      expect(done.reason, behave).toContain(reason);
      expect(attempts(done), behave).toBe(0);
    }
  });

  it('retries the node when the plugin asks to', async () => {
    const done = await probe('fail_retry');
    expect(done.status).toBe('failed');
    expect(done.reason).toContain('Probe busy');
    expect(attempts(done)).toBeGreaterThan(0);
  });

  it('keeps the last good manifest while a plugin cannot answer, and reports it unhealthy', async () => {
    const good = (await pluginStatuses(env, true))[0]!.manifest;
    const manifest = vi.fn().mockRejectedValue(new Error('connection reset'));
    const flaky = { PLUGIN_EXAMPLE: { fetch() {}, manifest } } as unknown as Env;
    const [s] = await pluginStatuses(flaky, true);
    expect(s).toMatchObject({ healthy: false, error: 'connection reset' });
    expect(s!.manifest).toEqual(good);
  });
});
