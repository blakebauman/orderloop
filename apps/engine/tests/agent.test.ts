import { env } from 'cloudflare:workers';
import { b2bOrderFlow, type Order, type OrderState } from '@orderloop/core';
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
});
