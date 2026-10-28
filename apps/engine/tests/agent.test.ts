import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  b2bOrderFlow,
  type Order,
  type OrderState,
  TIMELINE_BROADCAST,
  TIMELINE_CAP,
} from '@orderloop/core';
import { describe, expect, it } from 'vitest';

const flow = { ...b2bOrderFlow(), version: 1, publishedAt: 0 };
const order: Order = {
  id: 'ord_agent_test',
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  lines: [],
  meta: {},
  createdAt: 0,
  subtotal: 0,
  shipping: 0,
  tax: 0,
  total: 0,
};
const plan = (status: 'running' | 'succeeded') => ({
  nodes: { po_in: { status: 'succeeded' as const, runs: 1 }, extract: { status, runs: 1 } },
  edges: {},
});

describe('OrderAgent reports', () => {
  it('ignores replayed plan snapshots, dedupes timeline keys and accepts a new generation', async () => {
    const agent = env.ORDER_AGENT.getByName('agent-seq');
    await agent.init(order, flow, 'ord_agent_test-g1');
    const state = async () => (await agent.snapshot()) as OrderState;

    await agent.report({ generation: 1, seq: 5, status: 'running', plan: plan('succeeded') });
    // A replay after hibernation re-sends an older snapshot: it must not move the UI backwards.
    await agent.report({ generation: 1, seq: 3, plan: plan('running') });
    expect((await state()).nodes.extract!.status).toBe('succeeded');

    // A retried step re-sends its log line with the same key: replaced, not appended.
    const log = {
      at: 1,
      nodeId: 'extract',
      kind: 'node' as const,
      message: 'Extract: 2 lines',
      key: 'extract#1',
    };
    await agent.report({ generation: 1, log });
    await agent.report({ generation: 1, log: { ...log, at: 2 } });
    expect((await state()).timeline.filter((t) => t.key === 'extract#1')).toHaveLength(1);

    // Continue-as-new restarts sequencing: a new generation's seq 1 is fresh.
    await agent.continuedAs('ord_agent_test-g2', 2);
    await agent.report({ generation: 2, seq: 1, plan: plan('running') });
    const s = await state();
    expect(s.generation).toBe(2);
    expect(s.instanceId).toBe('ord_agent_test-g2');
    expect(s.nodes.extract!.status).toBe('running');
  });

  it('keeps terminal statuses and rolled-back nodes once set', async () => {
    const agent = env.ORDER_AGENT.getByName('agent-terminal');
    await agent.init({ ...order, id: 'ord_agent_terminal' }, flow, 'ord_agent_terminal-g1');
    await agent.report({
      generation: 1,
      node: { id: 'reserve', status: 'rolled_back', summary: 'Released 1' },
    });
    await agent.report({
      generation: 1,
      seq: 9,
      status: 'completed',
      plan: { nodes: { reserve: { status: 'succeeded', runs: 1 } }, edges: {} },
    });
    await agent.report({ generation: 1, seq: 10, status: 'running' });
    const s = (await agent.snapshot()) as OrderState;
    expect(s.status).toBe('completed');
    expect(s.nodes.reserve!.status).toBe('rolled_back');
  });

  it('keeps a short reason and the full error on the step', async () => {
    const agent = env.ORDER_AGENT.getByName('agent-reason');
    await agent.init({ ...order, id: 'ord_agent_reason' }, flow, 'ord_agent_reason-g1');
    const error = `Failed query: select "sku" from "products" where "sku" in (${'?, '.repeat(3000)}?)`;
    await agent.report({
      generation: 1,
      node: { id: 'extract', status: 'failed', error, endedAt: 1 },
    });
    // A reporter that sends a raw message anyway (an instance started before the Workflow summed
    // up failures) still leaves a short reason.
    await agent.report({ generation: 1, status: 'failed', reason: `Extract: ${error}` });
    // A replayed report changes nothing.
    await agent.report({ generation: 1, status: 'failed', reason: `Extract: ${error}` });
    const s = (await agent.snapshot()) as OrderState;
    expect(s.status).toBe('failed');
    expect(s.reason).toBe('Database error at Extract');
    expect(s.nodes.extract!.error).toBe(error);
    expect(s.timeline.filter((t) => t.message.startsWith('Order failed'))).toHaveLength(1);
  });

  it('broadcasts a small state and keeps the flow and whole timeline for snapshots', async () => {
    const agent = env.ORDER_AGENT.getByName('agent-slim');
    await agent.init({ ...order, id: 'ord_agent_slim' }, flow, 'ord_agent_slim-g1');
    const entries = TIMELINE_CAP + 20;
    for (let i = 0; i < entries; i++)
      await agent.report({
        generation: 1,
        log: { at: i, kind: 'node', message: `step ${i}`, key: `k${i}` },
      });
    // A retried step's line replaces its earlier copy and moves to the end.
    await agent.report({
      generation: 1,
      log: { at: 9999, kind: 'node', message: 'retried', key: `k${entries - 10}` },
    });

    const synced = await runInDurableObject(agent, async (a) => a.state);
    expect(synced.flow).toBeNull();
    expect(synced.timeline).toHaveLength(TIMELINE_BROADCAST);
    expect(synced.timeline.at(-1)!.message).toBe('retried');

    const s = (await agent.snapshot()) as OrderState;
    expect(s.flow).toEqual(flow);
    expect(s.timeline).toHaveLength(TIMELINE_CAP);
    expect(s.timeline.at(-1)!.message).toBe('retried');
    expect(s.timeline.filter((t) => t.key === `k${entries - 10}`)).toHaveLength(1);
    // The broadcast is the snapshot's newest entries.
    expect(s.timeline.slice(-TIMELINE_BROADCAST)).toEqual(synced.timeline);
    expect(await agent.getFlow()).toEqual(flow);
  });

  it('moves the flow and timeline out of the state of an order begun before', async () => {
    const agent = env.ORDER_AGENT.getByName('agent-legacy');
    const timeline = Array.from({ length: 120 }, (_, i) => ({
      at: i,
      kind: 'node' as const,
      message: `old ${i}`,
    }));
    await runInDurableObject(agent, async (a) => {
      a.setState({
        ...a.state,
        orderId: 'ord_agent_legacy',
        order: { ...order, id: 'ord_agent_legacy' },
        flow,
        instanceId: 'ord_agent_legacy-g1',
        generation: 1,
        status: 'running',
        timeline,
      });
    });
    await agent.report({ generation: 1, log: { at: 500, kind: 'node', message: 'new' } });
    const synced = await runInDurableObject(agent, async (a) => a.state);
    expect(synced.flow).toBeNull();
    expect(synced.timeline).toHaveLength(TIMELINE_BROADCAST);
    const s = (await agent.snapshot()) as OrderState;
    expect(s.flow).toEqual(flow);
    expect(s.timeline.map((t) => t.message)).toEqual([...timeline.map((t) => t.message), 'new']);
  });
});
