import { type FlowGraph, type NodeRun, staticRegistry, TEMPLATES } from '@orderloop/core';
import { describe, expect, it } from 'vitest';

const { FIT_MIN_ZOOM, fitViewport, frameFocus, holdPoints } = await import(
  '../app/components/flow-canvas'
);

const subscription = TEMPLATES['tpl-subscription']();

describe('where a flow’s orders wait or loop', () => {
  it('lists the subscription’s billing loop and its waits, in the order the flow reads', () => {
    const holds = holdPoints(subscription, staticRegistry);
    expect(holds.map((p) => p.id)).toEqual(['periods', 'renewal', 'retry_wait']);
    expect(holds[0]).toMatchObject({ label: 'Billing periods', kind: 'Loop' });
    expect(holds[1]).toMatchObject({ label: 'Until renewal', kind: 'Wait' });
  });

  it('counts approvals and events as waits, and nothing else', () => {
    const g = {
      nodes: [
        {
          id: 'ack',
          type: 'control.wait_event',
          label: 'Supplier acks',
          position: { x: 560, y: 0 },
        },
        { id: 'ok', type: 'control.approval', label: 'Sales approval', position: { x: 280, y: 0 } },
        { id: 'price', type: 'commerce.price', label: 'Price', position: { x: 0, y: 0 } },
      ],
      edges: [],
    } as unknown as FlowGraph;
    expect(holdPoints(g, staticRegistry).map((p) => [p.id, p.kind])).toEqual([
      ['ok', 'Approval'],
      ['ack', 'Wait for event'],
    ]);
  });
});

describe('what a canvas opens on', () => {
  it('opens a flow being built on its first loop or wait', () => {
    expect(frameFocus(subscription, undefined, holdPoints(subscription, staticRegistry))).toEqual([
      'periods',
    ]);
  });

  it('falls back to the trigger end for a flow with no loops or waits', () => {
    const straight = {
      nodes: subscription.nodes.filter((n) =>
        holdPoints(subscription, staticRegistry).every((p) => p.id !== n.id),
      ),
      edges: [],
    } as FlowGraph;
    const holds = holdPoints(straight, staticRegistry);
    expect(holds).toEqual([]);
    expect(frameFocus(straight, undefined, holds)).toEqual([]);
  });

  it('keeps an order’s framing on its run, never on the loop', () => {
    const holds = holdPoints(subscription, staticRegistry);
    const run = (status: NodeRun['status']) => ({ status }) as NodeRun;
    // Not started yet: the trigger end, as before.
    expect(frameFocus(subscription, {}, holds)).toEqual([]);
    expect(frameFocus(subscription, { charge: run('running') }, holds)).toEqual(['charge']);
    expect(
      frameFocus(subscription, { validate: run('succeeded'), retry: run('failed') }, holds),
    ).toEqual(['retry']);
    expect(frameFocus(subscription, { paused: run('succeeded') }, holds)).toEqual(['paused']);
  });
});

describe('Fit view', () => {
  // A 20-step flow: 20 columns of 220px steps, 280px apart, two rows.
  const wide = { x: 0, y: 0, width: 19 * 280 + 220, height: 300 };

  it('shows a flow that fits whole, centred and no larger than 1:1', () => {
    const small = { x: 0, y: 0, width: 500, height: 200 };
    expect(fitViewport(small, { x: 0, y: 0 }, 1200, 800)).toEqual({ x: 350, y: 300, zoom: 1 });
  });

  it('never shrinks a wide flow below readable labels', () => {
    const v = fitViewport(wide, { x: 2800, y: 150 }, 900, 700);
    expect(v.zoom).toBe(FIT_MIN_ZOOM);
    expect(13 * v.zoom).toBeGreaterThanOrEqual(10);
  });

  it('keeps what it can show around the anchor in the middle', () => {
    const v = fitViewport(wide, { x: 2800, y: 150 }, 900, 700);
    expect(450 - 2800 * v.zoom).toBeCloseTo(v.x);
    // The rows fit, so they're centred.
    expect(v.y).toBeCloseTo(350 - 150 * v.zoom);
  });

  it('stops at the flow’s edges rather than showing empty sheet', () => {
    const start = fitViewport(wide, { x: 0, y: 150 }, 900, 700);
    expect(start.x).toBeCloseTo(24);
    const end = fitViewport(wide, { x: wide.width, y: 150 }, 900, 700);
    expect(end.x + wide.width * end.zoom).toBeCloseTo(900 - 24);
  });
});
