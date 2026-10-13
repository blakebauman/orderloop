/**
 * What an operator needs to decide an approval, derived from the order's live state: the step that
 * routed the order here and, for credit checks, the numbers behind it. Pure; runs on both sides.
 */

import type { OrderState } from '@orderloop/core';
import { money } from './format';

export type ApprovalContext = {
  /** One line saying why a person is being asked, e.g. "Over credit limit by $2,332". */
  reason?: string;
  /** Supporting figures, e.g. ["Limit $20,000", "Balance $18,500"]. */
  facts: string[];
  /** When the approval escalates, if it does. */
  deadline?: number;
  /** The step the flow takes if nobody decides in time, e.g. "Decline order". */
  onTimeout?: string;
  /** The approval step asking, e.g. "Sales approval". */
  step?: string;
};

export function approvalContext(state: OrderState, nodeId: string): ApprovalContext {
  const flow = state.flow;
  const wait = state.waits.find((w) => w.nodeId === nodeId);
  const ctx: ApprovalContext = { facts: [], deadline: wait?.deadline };
  if (!flow) return ctx;
  ctx.step = flow.nodes.find((n) => n.id === nodeId)?.label;
  const currency = state.order?.currency ?? 'USD';
  const timeoutEdge = flow.edges.find(
    (e) => e.source === nodeId && (e.sourceHandle === 'escalated' || e.sourceHandle === 'timeout'),
  );
  if (timeoutEdge)
    ctx.onTimeout =
      flow.nodes.find((n) => n.id === timeoutEdge.target)?.label ?? timeoutEdge.target;
  for (const e of flow.edges.filter((x) => x.target === nodeId)) {
    const run = state.nodes[e.source];
    const source = flow.nodes.find((n) => n.id === e.source);
    if (!run || !source || run.status !== 'succeeded') continue;
    // Only the branch that actually led here explains the request.
    if (e.sourceHandle && run.branches && !run.branches.includes(e.sourceHandle)) continue;
    const out = (run.output ?? {}) as { limit?: number; balance?: number; available?: number };
    if (source.type === 'commerce.credit_check' && typeof out.available === 'number') {
      const over = (state.order?.total ?? 0) - out.available;
      ctx.reason =
        over > 0
          ? `Over credit limit by ${money(over, currency)}`
          : `Within credit, ${money(out.available, currency)} available`;
      ctx.facts.push(`This order ${money(state.order?.total ?? 0, currency)}`);
      if (typeof out.limit === 'number') ctx.facts.push(`Limit ${money(out.limit, currency)}`);
      if (typeof out.balance === 'number')
        ctx.facts.push(`Balance ${money(out.balance, currency)}`);
      if (out.available < 0)
        ctx.facts.push(`Already ${money(-out.available, currency)} over before this order`);
      return ctx;
    }
    if (run.summary) {
      ctx.reason = `${source.label}: ${run.summary.replace(/^→\s*/, '')}`;
      return ctx;
    }
  }
  return ctx;
}
