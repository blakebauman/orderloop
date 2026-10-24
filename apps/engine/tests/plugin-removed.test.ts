/**
 * A deployment without the example plugin, as after removing it: flows that use its nodes no longer
 * validate, and an order still pinned to one fails at that node and rolls back what came before.
 */

import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { validateGraph } from '@orderloop/core';
import { createDb, publishFlow, webhookDeliveries } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';
import { registry } from '../src/plugins';
import { settled, stampFlow, stampInput } from './plugin-helpers';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

beforeAll(async () => {
  await ensureTemplates(env);
  // Published while the plugin was installed (publishing skips validation at this layer).
  await publishFlow(db(), stampFlow('test-stamp-orphan', 'completed'));
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('a removed plugin', () => {
  it('lists nothing and checks nothing', async () => {
    expect(await api().pluginCatalog()).toEqual([]);
    expect(Object.keys((await api().health()).checks)).toEqual(['db', 'docs']);
  });

  it('makes its nodes invalid', async () => {
    const { errors } = validateGraph(stampFlow('x', 'completed'), await registry(env));
    expect(errors.map((e) => e.message)).toEqual(['Plugin “example” is not installed']);
  });

  it('fails an order at its node and rolls back the steps before it', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { orderId } = await startOrder(env, {
      flowId: 'test-stamp-orphan',
      input: stampInput(),
    });
    const done = await settled(orderId, 45_000);
    expect(done.status).toBe('rolled_back');
    expect(done.reason).toContain('Plugin “example” is not installed');
    expect(done.nodes.reserve!.status).toBe('rolled_back');
    // No plugin, so no plugin delivery was recorded.
    const delivered = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.orderId, orderId));
    expect(delivered.filter((d) => d.subscriptionId.startsWith('plugin:'))).toEqual([]);
  });

  it('still reports the flows that use it', async () => {
    const usage = await api().pluginUsage('example');
    expect(usage.flows.map((f) => f.id)).toContain('test-stamp-orphan');
  });
});
