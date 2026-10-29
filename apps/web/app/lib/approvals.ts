/**
 * What an operator needs to decide an approval, derived from the order's live state: why the flow
 * asks a person, in words, the figures behind it, what is being bought, and the approval steps that
 * came before this one. Pure; runs on both sides.
 */

import { BASE_CURRENCY, type FlowNode, type OrderState, toBase } from '@orderloop/core';
import { clock, money, orderRef, until } from './format';

/** Time a decision needs to reach the order before its step times out. */
export const SEND_MS = 1500;
/** Decisions close this long before the deadline, so the last one still arrives in time. */
const LOCK_LEAD_MS = SEND_MS + 500;
/** How long before closing the countdown warns that decisions are about to close. */
export const WARN_MS = 10_000;

/** When decisions on an approval close: a little before its step times out. */
export const lockAt = (deadline: number) => deadline - LOCK_LEAD_MS;

export type ApprovalContext = {
  /** One line saying why a person is being asked, e.g. "Over credit limit by $2,332". */
  reason?: string;
  /**
   * The rule that fired, without this order's own figures, e.g. "Over credit limit": what the
   * approvals that share it have in common, so the inbox can group them.
   */
  rule?: string;
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

/** What the approvals in one group of the inbox share: the flow, the step and the rule that fired. */
export type ApprovalGroup = {
  key: string;
  /** The approval step, e.g. "Finance approval". */
  step?: string;
  /** The flow the orders run, e.g. "Purchase request". */
  flow?: string;
  /** The rule that sent them here, e.g. "Over the $5,000.00 threshold". */
  rule?: string;
  /** Its rows, most urgent first. */
  ids: string[];
  /** The order title every row shares, when they all share one: said once, on the group. */
  title?: string;
  /** The soonest step deadline among its rows. */
  soonest?: number;
};

/** What grouping reads from a row. */
export type GroupRow = {
  id: string;
  nodeId: string;
  flowId?: string | null;
  flowName?: string | null;
  stepLabel?: string | null;
  orderTitle?: string | null;
};

/**
 * Groups a page of pending approvals by flow, step and the rule that fired, so a run of identical
 * requests reads as one group with its count instead of N rows told apart by a ref. Groups keep the
 * order of their most urgent row (the rows arrive sorted, `byUrgency`); rows keep theirs inside.
 * A row whose rule can't be read (no live state) groups by flow and step alone. Pure.
 */
export function groupApprovals<R extends GroupRow>(
  rows: R[],
  context: Record<string, ApprovalContext | undefined>,
): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  const titles = new Map<string, Set<string>>();
  for (const r of rows) {
    const ctx = context[r.id];
    const rule = ctx?.rule;
    // The node id names the step within its flow; a label alone could repeat across steps.
    const key = JSON.stringify([r.flowId ?? '', r.nodeId, rule ?? '']);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        step: ctx?.step ?? r.stepLabel ?? undefined,
        flow: r.flowName ?? undefined,
        rule,
        ids: [],
      };
      groups.set(key, g);
      titles.set(key, new Set());
    }
    g.ids.push(r.id);
    titles.get(key)!.add(r.orderTitle ?? '');
    const d = ctx?.deadline;
    if (d !== undefined && (g.soonest === undefined || d < g.soonest)) g.soonest = d;
  }
  for (const g of groups.values()) {
    const [only] = titles.get(g.key)!;
    if (g.ids.length > 1 && titles.get(g.key)!.size === 1 && only) g.title = only;
  }
  return [...groups.values()];
}

/** A group's name: "Finance approval · Purchase request · Over the $5,000.00 threshold". */
export const groupName = (g: Pick<ApprovalGroup, 'step' | 'flow' | 'rule'>) =>
  [g.step ?? 'Approval', g.flow, g.rule].filter(Boolean).join(' · ');

/** Where a pending row stands, for whether it can join a batch. */
export type RowStanding = {
  /** The person has the approver role. */
  canApprove: boolean;
  /** Separation of duties: why this person may not decide it. */
  refused?: string;
  /** The order has no live run to resume. */
  noRun?: boolean;
  /** Decisions on it have closed (its step is about to time out). */
  closed?: boolean;
  /** A decision on it waits on its card in the assistant, or has been made. */
  decided?: boolean;
};

/**
 * Why a row can't be selected for a batch, or null when it can. A batch decides each selected row
 * the way its own buttons would, so it holds to the same refusals: a row its person can't decide
 * alone can't be decided in a batch either.
 */
export function cannotSelect(s: RowStanding): string | null {
  if (!s.canApprove) return 'People with the approver role decide.';
  if (s.noRun) return 'No live run for this order, so it can’t be decided here.';
  if (s.refused) return s.refused;
  if (s.closed) return 'Decisions are closed.';
  if (s.decided) return 'Already decided.';
  return null;
}

/** How a row's deadline reads, deadline first: closed, closing now, soon, or at a time of day. */
export type DeadlineWords =
  | { kind: 'closed' }
  | { kind: 'soon' | 'in'; when: string }
  | { kind: 'at'; when: string };

/**
 * When decisions on an approval close, in words: within the hour as "in 3m", later as the clock
 * time it closes ("2:05 PM", or "Thu 2:05 PM" on another day). `timeZone` is for the server render,
 * which can't know the viewer's; it's labelled.
 */
export function deadlineWords(deadline: number, now: number, timeZone?: string): DeadlineWords {
  const lock = lockAt(deadline);
  const left = lock - now;
  if (left <= 0) return { kind: 'closed' };
  if (left <= WARN_MS) return { kind: 'soon', when: until(lock, now) };
  if (left < 60 * 60_000) return { kind: 'in', when: until(lock, now) };
  const day = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeZone }).format(ms);
  const time = clock(lock, timeZone, day(lock) !== day(now));
  return { kind: 'at', when: timeZone === 'UTC' ? `${time} UTC` : time };
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
    ctx.rule = over > 0 ? 'Over credit limit' : 'Within credit';
    return over > 0
      ? `Over credit limit by ${money(over, creditBase)}`
      : `Within credit, ${money(out.available, creditBase)} available`;
  }

  if (source.type === 'commerce.budget_check' && typeof out.budget === 'number') {
    ctx.facts.push(totalLine, `Budget ${money(out.budget, base)}`);
    ctx.rule = `${branch === 'over' ? 'Over' : 'Within'} the ${money(out.budget, base)} budget`;
    return branch === 'over'
      ? `Over the ${money(out.budget, base)} budget by ${money(total - out.budget, base)}`
      : `Within the ${money(out.budget, base)} budget`;
  }

  if (source.type === 'control.condition') {
    const threshold = thresholdOf(source.config.expression);
    if (threshold) {
      ctx.facts.push(totalLine);
      const met = branch !== 'false';
      ctx.rule = `${met ? threshold.words : `Not ${threshold.words.toLowerCase()}`} the ${money(threshold.value, base)} threshold`;
      return ctx.rule;
    }
    // A question the flow asked, e.g. "Over $5k?", answered.
    const question = source.label.replace(/\?\s*$/, '');
    ctx.rule = branch === 'false' ? `${question}: no` : question;
    return ctx.rule;
  }

  if (summary) {
    const said = summary
      .replace(/^→\s*/, '')
      .replace(/^true$/i, 'yes')
      .replace(/^false$/i, 'no');
    // A step's own words can carry this order's figures; the step alone is what is shared.
    ctx.rule = source.label;
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
