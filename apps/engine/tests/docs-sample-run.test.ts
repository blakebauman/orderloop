/**
 * The docs home page draws one real run of the B2B flow from apps/docs/src/data/sample-run.json.
 * This re-runs that scenario and fails when the engine would now draw it differently: another
 * path, other branches, or a different summary. The fix is to update the fixture from the
 * "Received" side of the diff (keeping its "$comment"), not to loosen this test.
 *
 * Invoice due dates, tracking numbers and ERP references differ on every run, so those three
 * summaries are compared by shape only.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderState } from '@orderloop/core';
import { afterEach, expect, it } from 'vitest';
import sample from '../../docs/src/data/sample-run.json';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';

const VOLATILE: Record<string, RegExp> = {
  invoice: /^net_30 · due \d{4}-\d{2}-\d{2}$/,
  ship: /^FREIGHT \S+$/,
  erp: /^NETSUITE-\S+$/,
};

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
});

it('still runs the B2B order drawn on the docs home page', async () => {
  await ensureTemplates(env);
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const { orderId } = await startOrder(env, {
    flowId: sample.flowId,
    input: {
      type: 'b2b_order',
      currency: 'USD',
      lines: [],
      meta: {},
      customerId: sample.order.customerId,
      // The dashboard's "B2B PO by email" scenario (apps/web/app/lib/scenarios.ts).
      documentText:
        'From: Northwind Traders\nSubject: PO #NW-7781\n\nHi team, please ship 120 x WID-100 (industrial widgets), 40 x GSK-010 gasket kits and 8 x WID-200.\nDeliver to dock 4. Thanks, Priya — Purchasing',
    },
  });

  let s: OrderState | undefined;
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
    if (s.waits.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const nodes = Object.fromEntries(
    Object.entries(s!.nodes).map(([id, n]) => {
      const summary = n.summary && VOLATILE[id]?.test(n.summary) ? '(varies)' : n.summary;
      return [id, { status: n.status, summary, branches: n.branches }];
    }),
  );
  const expected = Object.fromEntries(
    Object.entries(sample.nodes as Record<string, { summary?: string }>).map(([id, n]) => [
      id,
      { ...n, summary: n.summary && VOLATILE[id]?.test(n.summary) ? '(varies)' : n.summary },
    ]),
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
