/**
 * Where orders are, for the overview: open waits laid along each flow's steps, and this week's bad
 * endings grouped by the step they stopped at. Pure, so it is tested without D1
 * (tests/where.test.ts); the rows come from `overview()` and the steps from `flowSteps()`.
 */

import { humanize } from './format';

export type FlowSteps = { id: string; name: string; steps: string[] };

export type WaitRow = {
  flowId: string;
  /** The index's `waiting_at`: one step's label, or several joined with " · ". */
  at: string | null;
  /** The index's `waiting_for`: `person:<role>`, `event:<name>` or `timer`, joined with " · ". */
  for: string | null;
  n: number;
  oldest: number | null;
  /** How many are past their step's deadline (the index's `waiting_due`) when it was read. */
  overdue: number;
};

export type StoppedRow = {
  flowId: string;
  at: string | null;
  n: number;
  rolledBack: number;
  latest: number;
  reason: string | null;
};

/**
 * Whether a wait is overdue: past the deadline its step set (an approval's escalation or an event's
 * timeout). Only an overdue wait is drawn in the wait colour; one on time reads as any other figure.
 * A wait without a deadline (a timer) is never overdue.
 */
export function isOverdue(due: number | null | undefined, now: number): boolean {
  return due != null && due <= now;
}

/** What a wait is on, in words: a person's role, an outside event, or a timer. */
export function waitingOn(forValue: string | null): string | null {
  if (!forValue) return null;
  const parts = [
    ...new Set(
      forValue.split(' · ').map((f) => {
        if (f === 'timer') return 'a timer';
        // As the orders list names them (`waitingForLabel`): the role, or "an approver".
        if (f.startsWith('person:')) return humanize(f.slice('person:'.length)) || 'an approver';
        if (f.startsWith('event:')) return 'an outside event';
        return f;
      }),
    ),
  ];
  return parts.join(' or ');
}

/** A step's position in its flow, by its first label; steps the flow doesn't name go last. */
const rank = (steps: string[], at: string) => {
  const i = steps.indexOf(at.split(' · ')[0] ?? at);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

export type WaitStep = {
  step: string;
  n: number;
  oldest: number | null;
  overdue: number;
  on: string | null;
};
export type WaitTrail = { flowId: string; name: string; open: number; steps: WaitStep[] };

/** Each flow with orders waiting, most waiting first; its steps in the order the flow runs them. */
export function waitTrails(rows: WaitRow[], flows: FlowSteps[]): WaitTrail[] {
  const byId = new Map(flows.map((f) => [f.id, f]));
  const trails = new Map<string, WaitTrail>();
  for (const r of rows) {
    const flow = byId.get(r.flowId);
    const trail = trails.get(r.flowId) ?? {
      flowId: r.flowId,
      name: flow?.name ?? r.flowId,
      open: 0,
      steps: [],
    };
    trail.open += r.n;
    const step = r.at || 'An unnamed step';
    const same = trail.steps.find((s) => s.step === step);
    const on = waitingOn(r.for);
    if (same) {
      same.n += r.n;
      same.overdue += r.overdue;
      same.oldest =
        same.oldest === null
          ? r.oldest
          : r.oldest === null
            ? same.oldest
            : Math.min(same.oldest, r.oldest);
      if (on && same.on !== on) same.on = same.on ? `${same.on} or ${on}` : on;
    } else trail.steps.push({ step, n: r.n, oldest: r.oldest, overdue: r.overdue, on });
    trails.set(r.flowId, trail);
  }
  return [...trails.values()]
    .map((t) => ({
      ...t,
      steps: t.steps.sort(
        (a, b) =>
          rank(byId.get(t.flowId)?.steps ?? [], a.step) -
          rank(byId.get(t.flowId)?.steps ?? [], b.step),
      ),
    }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}

export type StoppedStep = {
  flowId: string;
  name: string;
  step: string;
  n: number;
  rolledBack: number;
  latest: number;
  reason: string | null;
};

/** This week's bad endings by flow and step, the step with the most first. */
export function stoppedSteps(rows: StoppedRow[], flows: FlowSteps[]): StoppedStep[] {
  const byId = new Map(flows.map((f) => [f.id, f.name]));
  return rows
    .map((r) => ({
      flowId: r.flowId,
      name: byId.get(r.flowId) ?? r.flowId,
      step: r.at || 'Before any step',
      n: r.n,
      rolledBack: r.rolledBack,
      latest: r.latest,
      reason: r.reason,
    }))
    .sort((a, b) => b.n - a.n || b.latest - a.latest);
}
