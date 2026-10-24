/**
 * Shared by the plugin tests: a flow around the example plugin's `example.stamp` node, and waiting
 * for an order to settle.
 */

import { env } from 'cloudflare:workers';
import type { FlowNode, OrderInput, OrderState } from '@orderloop/core';

export const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  label: id,
  config,
  position: { x: 0, y: 0 },
});

export const edge = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle: sourceHandle ?? null,
  targetHandle: null,
});

/** start → reserve → stamp → end (`outcome`); `skip` sends the stamp down its other branch. */
export const stampFlow = (id: string, outcome: 'completed' | 'failed', skip = false) => ({
  id,
  name: 'Stamp',
  description: '',
  model: 'b2b',
  channels: [],
  nodes: [
    node('start', 'trigger.manual'),
    node('reserve', 'commerce.reserve_inventory'),
    node('stamp', 'example.stamp', { note: 'hello', skip }),
    node('done', 'control.end', { outcome, reason: outcome }),
    node('skipped', 'control.end', { outcome: 'completed', reason: 'skipped' }),
  ],
  edges: [
    edge('start', 'reserve'),
    edge('reserve', 'stamp', 'ok'),
    edge('stamp', 'done', 'ok'),
    edge('stamp', 'skipped', 'skipped'),
  ],
});

/** start → probe (`behave`) → end: one call into the plugin, doing as told. */
export const probeFlow = (id: string, behave: string) => ({
  id,
  name: 'Probe',
  description: '',
  model: 'b2b',
  channels: [],
  nodes: [
    node('start', 'trigger.manual'),
    node('probe', 'example.probe', { behave }),
    node('done', 'control.end', { outcome: 'completed', reason: 'probed' }),
  ],
  edges: [edge('start', 'probe'), edge('probe', 'done')],
});

export const stampInput = (): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId: 'cus_northwind',
  lines: [{ sku: 'WID-100', qty: 1 }],
  meta: {},
});

const state = async (id: string) => (await env.ORDER_AGENT.getByName(id).snapshot()) as OrderState;

/**
 * Waits for the order to end. A failed order is rolled back after it reports failed, so by default
 * this also waits for that outcome; pass `rollback: false` for a flow with nothing to roll back.
 */
export async function settled(
  id: string,
  ms = 30_000,
  { rollback = true } = {},
): Promise<OrderState> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state(id);
    if (['completed', 'declined', 'cancelled', 'failed', 'rolled_back'].includes(s.status))
      if (s.status !== 'failed' || s.rollback || !rollback) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${id} to settle`);
}
