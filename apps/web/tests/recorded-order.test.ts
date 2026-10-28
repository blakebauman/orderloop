import type { FlowGraph } from '@orderloop/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => ({}) }));

const { recordedRuns } = await import('../app/lib/orders.server');

const graph = {
  nodes: [
    { id: 'validate', type: 'commerce.validate', label: 'Validate', position: { x: 0, y: 0 } },
    { id: 'approve', type: 'control.approval', label: 'Sales approval', position: { x: 1, y: 0 } },
    {
      id: 'reply',
      type: 'control.wait_event',
      label: 'Customer replies',
      position: { x: 2, y: 0 },
    },
  ],
  edges: [],
} as unknown as FlowGraph;

const step = (nodeId: string, status: string, run = 1) => ({
  nodeId,
  status,
  run,
  startedAt: run * 1000,
  endedAt: run * 1000 + 50,
});

describe('a recorded order’s graph', () => {
  it('colours each step by its last run and marks where an open order waits', () => {
    const runs = recordedRuns(
      graph,
      [step('validate', 'failed', 1), step('validate', 'succeeded', 2)],
      { status: 'waiting', waitingAt: 'Sales approval · Customer replies', waitingSince: 9 },
    );
    expect(runs.validate).toMatchObject({ status: 'succeeded', runs: 2 });
    expect(runs.approve).toMatchObject({ status: 'waiting', startedAt: 9 });
    expect(runs.reply).toMatchObject({ status: 'waiting' });
  });

  it('shows no waits once the order has ended', () => {
    const runs = recordedRuns(graph, [step('validate', 'failed')], {
      status: 'failed',
      waitingAt: 'Sales approval',
      waitingSince: 9,
    });
    expect(runs).toEqual({ validate: expect.objectContaining({ status: 'failed' }) });
  });
});
