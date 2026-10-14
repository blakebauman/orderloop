/**
 * The docs home page draws real runs from apps/docs/src/data/runs/*.json. This replays each one on
 * its recorded input and fails when the engine would now draw it differently: another path, other
 * branches, or a different summary. The fix is to update the fixture from the "Received" side of
 * the diff (keeping its "$comment" and "input"), not to loosen this test.
 *
 * Due dates, tracking numbers, references, pickup codes and order ids differ on every run, so the
 * summaries that carry them are compared by shape only.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderInputDraft, OrderState } from '@orderloop/core';
import { afterEach, expect, it } from 'vitest';
import b2b from '../../docs/src/data/runs/b2b-order.json';
import pickup from '../../docs/src/data/runs/pickup-order.json';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';

type Run = {
  flowId: string;
  input: unknown;
  status: string;
  order: { subtotal: number; tax: number; total: number };
  waits: unknown[];
  nodes: Record<string, { status: string; summary?: string }>;
};

const RUNS: [string, Run, Record<string, RegExp>][] = [
  [
    'pickup-order',
    pickup,
    {
      ready: /^Pickup code [0-9A-Z]{6}$/,
      ready_note: /^→ ada@example\.com: Order ord_\w+ is ready at SoHo store$/,
    },
  ],
  [
    'b2b-order',
    b2b,
    {
      invoice: /^net_30 · due \d{4}-\d{2}-\d{2} · on account$/,
      ship: /^FREIGHT \S+$/,
      erp: /^NETSUITE-\S+$/,
    },
  ],
];

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
});

for (const [name, sample, volatile] of RUNS) {
  it(`still runs the ${name} drawn on the docs home page`, async () => {
    await ensureTemplates(env);
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { orderId } = await startOrder(env, {
      flowId: sample.flowId,
      input: sample.input as OrderInputDraft,
    });

    let s: OrderState | undefined;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      if (s.waits.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const shape = (id: string, summary?: string) =>
      summary && volatile[id]?.test(summary) ? '(varies)' : summary;
    const nodes = Object.fromEntries(
      Object.entries(s!.nodes).map(([id, n]) => [
        id,
        { status: n.status, summary: shape(id, n.summary), branches: n.branches },
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(sample.nodes).map(([id, n]) => [id, { ...n, summary: shape(id, n.summary) }]),
    );
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(expected);
    expect({
      status: s!.status,
      subtotal: s!.order!.subtotal,
      tax: s!.order!.tax,
      total: s!.order!.total,
      waits: s!.waits.map((w) => ({
        nodeId: w.nodeId,
        kind: w.kind,
        event: w.event,
        title: w.title,
      })),
    }).toEqual({
      status: sample.status,
      subtotal: sample.order.subtotal,
      tax: sample.order.tax,
      total: sample.order.total,
      waits: sample.waits,
    });
  });
}
