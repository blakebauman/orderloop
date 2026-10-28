import type { FlowGraph } from '@orderloop/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/env.server', () => ({ db: () => ({}) }));

const { recordedEdges, recordedReversals, recordedRuns } = await import('../app/lib/orders.server');
const { clearRightEdge } = await import('../app/components/flow-canvas');
const { liveStatus, statusColor } = await import('../app/lib/format');

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

/** Validate branches to Ship or Reject; Ship runs into a loop that goes round again. */
const branching = {
  nodes: [
    { id: 'validate', type: 'commerce.validate', label: 'Validate', position: { x: 0, y: 0 } },
    { id: 'ship', type: 'commerce.ship', label: 'Ship', position: { x: 1, y: 0 } },
    { id: 'reject', type: 'commerce.notify', label: 'Reject', position: { x: 1, y: 1 } },
    { id: 'loop', type: 'control.loop', label: 'Each parcel', position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e-ship', source: 'validate', target: 'ship', sourceHandle: 'ok', targetHandle: null },
    {
      id: 'e-reject',
      source: 'validate',
      target: 'reject',
      sourceHandle: 'invalid',
      targetHandle: null,
    },
    { id: 'e-loop', source: 'ship', target: 'loop', sourceHandle: null, targetHandle: null },
    { id: 'e-again', source: 'loop', target: 'ship', sourceHandle: 'body', targetHandle: 'next' },
  ],
} as unknown as FlowGraph;

describe('a recorded order’s path', () => {
  it('inks the edges it took and fades the rest once the order has ended', () => {
    const runs = recordedRuns(branching, [step('validate', 'succeeded'), step('ship', 'failed')], {
      status: 'failed',
      waitingAt: null,
      waitingSince: null,
    });
    expect(recordedEdges(branching, runs, { status: 'failed' })).toEqual({
      'e-ship': 'active',
      'e-reject': 'inactive',
      // Ship failed, so nothing left it.
      'e-loop': 'inactive',
      'e-again': 'inactive',
    });
  });

  it('on an open order, fades only the branches not taken and leaves the rest to come', () => {
    const runs = recordedRuns(branching, [step('validate', 'succeeded')], {
      status: 'waiting',
      waitingAt: 'Ship',
      waitingSince: 9,
    });
    expect(recordedEdges(branching, runs, { status: 'waiting' })).toEqual({
      'e-ship': 'active',
      'e-reject': 'inactive',
      'e-loop': 'pending',
      'e-again': 'pending',
    });
  });

  it('takes a loop’s back edge only when its target ran again', () => {
    const once = recordedRuns(
      branching,
      [step('validate', 'succeeded'), step('ship', 'succeeded'), step('loop', 'succeeded')],
      { status: 'completed', waitingAt: null, waitingSince: null },
    );
    expect(recordedEdges(branching, once, { status: 'completed' })['e-again']).toBe('inactive');
    const twice = recordedRuns(
      branching,
      [
        step('validate', 'succeeded'),
        step('ship', 'succeeded', 1),
        step('loop', 'succeeded'),
        step('ship', 'succeeded', 2),
      ],
      { status: 'completed', waitingAt: null, waitingSince: null },
    );
    expect(recordedEdges(branching, twice, { status: 'completed' })['e-again']).toBe('active');
  });

  it('has no path without the flow it ran on', () => {
    expect(recordedEdges(null, {}, { status: 'completed' })).toEqual({});
  });
});

const none = {
  reservationsReleased: 0,
  authorizationsVoided: 0,
  sellerOrdersCancelled: 0,
  payoutsReversed: 0,
  shipmentsCancelled: 0,
  invoicesVoided: 0,
  codesRevoked: 0,
};
const ran = (nodeId: string, type: string, status = 'succeeded', startedAt = 1) => ({
  nodeId,
  type,
  status,
  startedAt,
});

describe('what a rolled-back order’s records show was undone', () => {
  it('ties each reversal to the step that made what was reversed', () => {
    expect(
      recordedReversals(
        [
          ran('validate', 'commerce.validate'),
          ran('authorize', 'commerce.authorize_payment', 'succeeded', 2),
          ran('reserve', 'commerce.reserve_inventory', 'succeeded', 3),
          ran('ship', 'commerce.ship', 'failed', 4),
        ],
        { ...none, reservationsReleased: 2, authorizationsVoided: 1, shipmentsCancelled: 1 },
      ),
    ).toEqual([
      { nodeId: 'authorize', text: 'Voided 1 payment authorization' },
      { nodeId: 'reserve', text: 'Released 2 stock reservations' },
    ]);
  });

  it('reverses nothing the records don’t show, even on a step that could be undone', () => {
    expect(
      recordedReversals(
        [ran('authorize', 'commerce.authorize_payment'), ran('split', 'commerce.split_by_seller')],
        none,
      ),
    ).toEqual([]);
  });

  it('skips a step whose last run failed, and gives shared records to one step', () => {
    expect(
      recordedReversals(
        [
          ran('reserve', 'commerce.reserve_inventory', 'succeeded', 1),
          ran('reserve', 'commerce.reserve_inventory', 'failed', 2),
          ran('pickup', 'commerce.pickup_ready', 'succeeded', 3),
          ran('ship', 'commerce.ship', 'succeeded', 4),
        ],
        { ...none, reservationsReleased: 1, shipmentsCancelled: 1 },
      ),
    ).toEqual([{ nodeId: 'pickup', text: 'Cancelled 1 pickup' }]);
  });
});

describe('framing a flow from its first step', () => {
  // Three 220px steps, 280px apart.
  const spans = [0, 280, 560].map((x) => ({ left: x, right: x + 220 }));

  it('keeps the zoom when the frame already ends between steps', () => {
    expect(clearRightEdge(spans, 0, 1, 2000)).toBe(1);
  });

  it('zooms out just enough to end the frame after the step it would cut', () => {
    // At 1 the frame (700px of room) ends inside the third step, which ends at 780.
    expect(clearRightEdge(spans, 0, 1, 748)).toBeCloseTo(700 / 780);
  });

  it('never goes below a readable zoom to do it', () => {
    // Ending after the second step would take 252 / 500, about 0.5.
    expect(clearRightEdge(spans, 0, 1, 300)).toBe(1);
  });
});

describe('liveStatus', () => {
  it('shows an open order with no run as recorded, in the idle tone, never waiting', () => {
    for (const status of ['queued', 'running', 'waiting'])
      expect(liveStatus({ status, instanceId: null })).toBe('recorded');
    expect(statusColor(liveStatus({ status: 'waiting', instanceId: null }))).toBe('var(--idle)');
  });

  it('keeps an ended order’s status, and every status of an order with a run', () => {
    expect(liveStatus({ status: 'completed', instanceId: null })).toBe('completed');
    expect(liveStatus({ status: 'rolled_back', instanceId: null })).toBe('rolled_back');
    expect(liveStatus({ status: 'waiting', instanceId: 'ord_a-g1' })).toBe('waiting');
  });
});
