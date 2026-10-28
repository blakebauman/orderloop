/**
 * What an operator needs to decide an approval, derived from the order's live state: why the flow
 * asks a person, in words, the figures behind it, what is being bought, and the approval steps that
 * came before this one. Pure; runs on both sides.
 */

import { BASE_CURRENCY, type FlowNode, type OrderState, toBase } from '@orderloop/core';
import { money, orderRef } from './format';

export type ApprovalContext = {
  /** One line saying why a person is being asked, e.g. "Over credit limit by $2,332". */
  reason?: string;
  /** Supporting figures, e.g. ["Limit $20,000", "Balance $18,500"]. */
  facts: string[];
  /** What the order is for, e.g. "8 × LAP-14, 8 × MON-27". */
  lines?: string;
  /** Earlier approval steps on the way here, oldest first, e.g. "Manager approval timed out". */
  trail: string[];
  /** When the approval escalates, if it does. */
  deadline?: number;
  /** The step the flow takes if nobody decides in time, e.g. "Decline order". */
  onTimeout?: string;
  /** The approval step asking, e.g. "Sales approval". */
  step?: string;
};

/** What the approvals inbox and the overview know of a pending or decided approval. */
export type ApprovalRecord = {
  orderId: string;
  nodeId: string;
  title: string;
  stepLabel?: string | null;
};

/**
 * The context for one approval row: from the order's live state when it could be read, and from
 * the approval's own record otherwise or where the live state has no reason to give. The record
 * offers its title (with the order's ref in place of its id, which the row already shows) as the
 * reason and the step's label from the flow version the order pinned.
 */
export function rowContext(state: OrderState | null | undefined, r: ApprovalRecord) {
  const ctx: ApprovalContext = state ? approvalContext(state, r.nodeId) : { facts: [], trail: [] };
  ctx.reason ??= r.title.split(r.orderId).join(orderRef(r.orderId)).trim() || undefined;
  ctx.step ??= r.stepLabel ?? undefined;
  return ctx;
}

/**
 * The order a page of the inbox reads in: rows that can be decided here first, soonest escalation
 * first, then the longest waiting; rows whose order has no live run last. The queue already holds
 * only orders the index says have a run (`listApprovals`' live scope); this catches one whose run
 * the engine can't find when the page reads it. Sorts in place.
 */
export function byUrgency<R extends { id: string; orderId: string; requestedAt: number }>(
  rows: R[],
  context: Record<string, ApprovalContext | undefined>,
  noRun: Record<string, boolean | undefined>,
): R[] {
  const deadline = (r: R) => context[r.id]?.deadline ?? Number.POSITIVE_INFINITY;
  return rows.sort(
    (a, b) =>
      Number(!!noRun[a.orderId]) - Number(!!noRun[b.orderId]) ||
      deadline(a) - deadline(b) ||
      a.requestedAt - b.requestedAt,
  );
}

/** How far back through earlier approvals to look for the reason. */
const MAX_HOPS = 4;

export function approvalContext(state: OrderState, nodeId: string): ApprovalContext {
  const flow = state.flow;
  const wait = state.waits.find((w) => w.nodeId === nodeId);
  const ctx: ApprovalContext = { facts: [], trail: [], deadline: wait?.deadline };
  ctx.lines = linesOf(state);
  if (!flow) return ctx;
  ctx.step = flow.nodes.find((n) => n.id === nodeId)?.label;
  const timeoutEdge = flow.edges.find(
    (e) => e.source === nodeId && (e.sourceHandle === 'escalated' || e.sourceHandle === 'timeout'),
  );
  if (timeoutEdge)
    ctx.onTimeout =
      flow.nodes.find((n) => n.id === timeoutEdge.target)?.label ?? timeoutEdge.target;
  explain(state, nodeId, ctx, 0);
  return ctx;
}

/** Fills `ctx.reason` and `ctx.facts` from the step whose branch led to `nodeId`. */
function explain(state: OrderState, nodeId: string, ctx: ApprovalContext, hops: number) {
  const flow = state.flow!;
  for (const e of flow.edges.filter((x) => x.target === nodeId)) {
    const run = state.nodes[e.source];
    const source = flow.nodes.find((n) => n.id === e.source);
    if (!run || !source || run.status !== 'succeeded') continue;
    // Only the branch that actually led here explains the request.
    if (e.sourceHandle && run.branches && !run.branches.includes(e.sourceHandle)) continue;
    const branch = run.branches?.[0];

    // An earlier approval isn't the reason; it's history. The reason is what sent the order to it.
    if (source.type === 'control.approval') {
      ctx.trail.unshift(approvalOutcome(source.label, branch, run.output));
      if (hops < MAX_HOPS) explain(state, source.id, ctx, hops + 1);
      return;
    }
    const reason = reasonFor(state, source, branch, run.output, run.summary, ctx);
    if (reason) {
      ctx.reason = reason;
      return;
    }
  }
}

function reasonFor(
  state: OrderState,
  source: FlowNode,
  branch: string | undefined,
  output: unknown,
  summary: string | undefined,
  ctx: ApprovalContext,
): string | undefined {
  const order = state.order;
  const currency = order?.currency ?? BASE_CURRENCY;
  const base = BASE_CURRENCY;
  const total = order?.baseTotal ?? toBase(order?.total ?? 0, order?.fxRate);
  const totalLine = `This order ${money(order?.total ?? 0, currency)}${currency !== base ? ` (${money(total, base)})` : ''}`;
  const out = (output ?? {}) as {
    limit?: number;
    balance?: number;
    available?: number;
    currency?: string;
    budget?: number;
  };

  if (source.type === 'commerce.credit_check' && typeof out.available === 'number') {
    // Limits and balances are in the base currency; so is the comparison.
    const creditBase = out.currency ?? base;
    const over = total - out.available;
    ctx.facts.push(totalLine);
    if (typeof out.limit === 'number') ctx.facts.push(`Limit ${money(out.limit, creditBase)}`);
    if (typeof out.balance === 'number')
      ctx.facts.push(`Balance ${money(out.balance, creditBase)}`);
    if (out.available < 0)
      ctx.facts.push(`Already ${money(-out.available, creditBase)} over before this order`);
    return over > 0
      ? `Over credit limit by ${money(over, creditBase)}`
      : `Within credit, ${money(out.available, creditBase)} available`;
  }

  if (source.type === 'commerce.budget_check' && typeof out.budget === 'number') {
    ctx.facts.push(totalLine, `Budget ${money(out.budget, base)}`);
    return branch === 'over'
      ? `Over the ${money(out.budget, base)} budget by ${money(total - out.budget, base)}`
      : `Within the ${money(out.budget, base)} budget`;
  }

  if (source.type === 'control.condition') {
    const threshold = thresholdOf(source.config.expression);
    if (threshold) {
      ctx.facts.push(totalLine);
      const met = branch !== 'false';
      return `${met ? threshold.words : `Not ${threshold.words.toLowerCase()}`} the ${money(threshold.value, base)} threshold`;
    }
    // A question the flow asked, e.g. "Over $5k?", answered.
    const question = source.label.replace(/\?\s*$/, '');
    return branch === 'false' ? `${question}: no` : question;
  }

  if (summary) {
    const said = summary
      .replace(/^→\s*/, '')
      .replace(/^true$/i, 'yes')
      .replace(/^false$/i, 'no');
    return `${source.label}: ${said}`;
  }
  return undefined;
}

/** "Manager approval approved by Dana" / "Manager approval timed out". */
function approvalOutcome(label: string, branch: string | undefined, output: unknown): string {
  const by = (output as { by?: unknown } | undefined)?.by;
  if (branch === 'escalated') return `${label} timed out`;
  if (branch === 'approved' || branch === 'rejected')
    return `${label} ${branch}${typeof by === 'string' && by ? ` by ${by}` : ''}`;
  return label;
}

const WORDS: Record<string, string> = {
  '>': 'Over',
  '>=': 'At least',
  '<': 'Under',
  '<=': 'At most',
};

/**
 * A comparison of the order's total with a number, e.g. `{">": [{"var": "order.total"}, 5000]}`,
 * as words and the threshold. Anything else isn't a threshold this can say plainly.
 */
function thresholdOf(expr: unknown): { words: string; value: number } | null {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return null;
  const [op, args] = Object.entries(expr as Record<string, unknown>)[0] ?? [];
  if (!op || !WORDS[op] || !Array.isArray(args) || args.length !== 2) return null;
  const [a, b] = args as [unknown, unknown];
  const path = (a as { var?: unknown } | null)?.var;
  if (
    (path === 'order.total' || path === 'order.baseTotal') &&
    typeof b === 'number' &&
    Number.isFinite(b)
  )
    return { words: WORDS[op]!, value: b };
  return null;
}

/** "8 × LAP-14, 8 × MON-27", the first three lines and how many more. */
function linesOf(state: OrderState): string | undefined {
  const lines = state.order?.lines ?? [];
  if (!lines.length) return undefined;
  const shown = lines.slice(0, 3).map((l) => `${l.qty} × ${l.name ?? l.sku}`);
  const more = lines.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}
