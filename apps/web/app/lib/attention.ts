/**
 * Open waits as lanes for the overview: grouped by who or what they wait on (a person, the outside
 * world, a timer), then by step, with how many orders and the oldest. Pure; runs on both sides.
 */

import { waitingForLabel, waitLabel } from './format';

export type WaitGroup = 'people' | 'outside' | 'timers' | 'unknown';

export type Lane = {
  group: WaitGroup;
  /** The step holding the orders, e.g. "Sales approval". */
  step: string;
  /** Who or what it waits on, e.g. "Sales ops", "Payment"; empty when the index doesn't say. */
  on: string;
  n: number;
  oldest: number | null;
};

export const GROUP_LABEL: Record<WaitGroup, string> = {
  people: 'On people',
  outside: 'On the outside world',
  timers: 'On a timer',
  unknown: 'Not yet indexed',
};

/** Where each group is acted on. */
export const GROUP_HREF: Record<WaitGroup, string> = {
  people: '/approvals',
  outside: '/commerce#outside-events',
  timers: '/orders?status=waiting',
  unknown: '/orders?status=waiting',
};

type WaitRow = {
  at: string | null;
  on: string | null;
  for: string | null;
  n: number;
  oldest: number | null;
};

/** People first (they are ours to clear), then the outside world, timers, and rows not yet indexed. */
const ORDER: WaitGroup[] = ['people', 'outside', 'timers', 'unknown'];

function groupOf(r: WaitRow): WaitGroup {
  const tokens = (r.for ?? '').split(' · ').filter(Boolean);
  if (tokens.some((t) => t.startsWith('person:'))) return 'people';
  if (tokens.some((t) => t.startsWith('event:'))) return 'outside';
  if (tokens.includes('timer')) return 'timers';
  // Rows indexed before `waiting_for` existed: the wait's title still tells an event from a person.
  if (r.on) return /^waiting for\s/i.test(r.on) ? 'outside' : 'people';
  return 'unknown';
}

export function lanes(rows: WaitRow[]): Lane[] {
  const byKey = new Map<string, Lane>();
  for (const r of rows) {
    const group = groupOf(r);
    const step = r.at || waitLabel(r.on) || 'Step not recorded';
    const on = waitingForLabel(r.for);
    const key = `${group}\u0000${step}\u0000${on}`;
    const lane = byKey.get(key);
    if (lane) {
      lane.n += r.n;
      lane.oldest =
        lane.oldest === null
          ? r.oldest
          : r.oldest === null
            ? lane.oldest
            : Math.min(lane.oldest, r.oldest);
    } else byKey.set(key, { group, step, on, n: r.n, oldest: r.oldest });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      ORDER.indexOf(a.group) - ORDER.indexOf(b.group) ||
      (a.oldest ?? Number.POSITIVE_INFINITY) - (b.oldest ?? Number.POSITIVE_INFINITY),
  );
}
