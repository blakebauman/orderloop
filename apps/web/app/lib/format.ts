import {
  type NodeStatus,
  ORDER_CHANNEL_LABELS,
  type OrderChannel,
  type OrderStatus,
} from '@orderloop/core';
import { eventShort } from './events';

export const STATUS_COLOR: Record<NodeStatus | OrderStatus | 'recorded', string> = {
  pending: 'var(--idle)',
  queued: 'var(--idle)',
  running: 'var(--run)',
  waiting: 'var(--wait)',
  succeeded: 'var(--ok)',
  completed: 'var(--ok)',
  // A person's or a policy's decision: neutral, not the rollback's orange or a failure's red.
  declined: 'var(--idle)',
  failed: 'var(--bad)',
  skipped: 'var(--idle)',
  cancelled: 'var(--idle)',
  rolled_back: 'var(--undo)',
  // An open order with no run (`liveStatus`): history, not work, so never the wait's amber.
  recorded: 'var(--idle)',
};

export const statusColor = (s: string | undefined) =>
  STATUS_COLOR[(s ?? 'pending') as NodeStatus] ?? 'var(--idle)';

/**
 * The status to show for an order. Orders declined before `declined` existed were stored as
 * cancelled; the approvals table identifies them, so they read "declined" too.
 */
export const orderStatus = (status: string, id: string, declined?: Set<string> | string[]) =>
  status === 'cancelled' && (Array.isArray(declined) ? declined.includes(id) : declined?.has(id))
    ? 'declined'
    : status;

/**
 * An order's status as live work. An order the index left open but the engine has no run for (a
 * recorded one: no `instanceId`) can't move, so it reads "recorded" rather than queued, running or
 * waiting, and nothing counts it as overdue. An ended order keeps its status.
 */
export function liveStatus(o: { status: string; instanceId: string | null }) {
  return !o.instanceId && ['queued', 'running', 'waiting'].includes(o.status)
    ? 'recorded'
    : o.status;
}

/** Sentence-case status for badges: "rolled_back" → "Rolled back". */
export const statusLabel = (s: string) => humanize(s);

/** Internal identifiers to operator words: "sales_ops" → "Sales ops", "net_30" → "Net 30". */
export function humanize(s: string | null | undefined) {
  if (!s) return '';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Who an approval is assigned to, by the assignee a flow names: the seeded templates' teams by
 * name ("ap" is "Accounts payable"), any other in operator words. A flow's assignee is free text,
 * so an unknown short one reads as the abbreviation it probably is ("qa" → "QA").
 */
const ASSIGNEE_LABELS: Record<string, string> = {
  ap: 'Accounts payable',
  buyer: 'Buyer',
  finance: 'Finance',
  manager: 'Manager',
  sales_ops: 'Sales ops',
  trust_safety: 'Trust and safety',
};

export function assigneeLabel(s: string | null | undefined) {
  if (!s) return '';
  return ASSIGNEE_LABELS[s] ?? (/^[a-z]{2,3}$/.test(s) ? s.toUpperCase() : humanize(s));
}

/** Where an order came in, by its channel; a value the app doesn't know isn't shown raw. */
export const channelLabel = (c: string) =>
  ORDER_CHANNEL_LABELS[c as OrderChannel] ?? 'Other channel';

/**
 * Free text for one line: its first line, whitespace collapsed, cut at a word with "…" past
 * `max`. Order reasons are capped by the engine; this keeps a row indexed before that (once a
 * whole SQL statement) from laying out kilobytes.
 */
export function clip(s: string, max = 160) {
  const line = s.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.·-]+$/, '')}…`;
}

/**
 * How an approval or wait ended, in operator words. The flow's output stays `escalated` (or
 * `timeout`); what a person sees is that the step timed out.
 */
export function outcomeLabel(s: string | null | undefined) {
  return s === 'escalated' || s === 'timeout' ? 'Timed out' : humanize(s);
}

/** Whole quantities with thousands separators: 25000 → "25,000". */
export const count = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** "1 line" / "3 lines" / "1,200 lines". */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;

export function money(n: number | null | undefined, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n ?? 0);
}

/**
 * "Oct 13, 2026, 4:46 AM". Pass `timeZone` to pin the zone (server rendering uses UTC, so the
 * markup matches during hydration); omit it for the viewer's own zone. See `useDateTime`.
 */
export function dateTime(ms: number, timeZone?: string) {
  const s = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(ms);
  return timeZone === 'UTC' ? `${s} UTC` : s;
}

export function ago(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Time remaining until a deadline: "in 42m", "in 3h", or "overdue". */
export function until(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return '';
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return 'overdue';
  if (s < 60) return `in ${s}s`;
  if (s < 120) return `in 1m ${s - 60}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** Elapsed time since the first entry, for logs whose wall-clock times collapse under TIME_SCALE. */
export function offset(ms: number, from: number) {
  const s = Math.max(0, (ms - from) / 1000);
  if (s < 60) return `+${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `+${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * What an order waits on, without engine identifiers: "Approve B2B order ord_x1 for cus_contoso"
 * reads "Approve B2B order". Same waits then group together. A title whose customer interpolated
 * to nothing ("… for ", from flows published before the B2B template dropped it) loses the "for".
 */
export const waitLabel = (s: string | null | undefined): string =>
  (s ?? '')
    .split(' · ')
    .map((part) => cleanWait(part))
    .filter(Boolean)
    .join(' · ');

const cleanWait = (s: string) =>
  (/^Waiting for\s+[\w.]+$/i.test(s.trim())
    ? eventShort(s.trim().replace(/^Waiting for\s+/i, ''))
    : s
  )
    .replace(/^Waiting for\s+/i, '')
    .replace(/\s+for\s+cus_[\w-]+/g, '')
    .replace(/\s*\b(ord|cus|apr)_[\w-]+/g, '')
    .replace(/\s+for\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/**
 * Who or what an order's open waits are on, from the index's `waiting_for`: "Sales ops",
 * "Payment", "a timer". An approval with no role is "an approver".
 */
export const waitingForLabel = (s: string | null | undefined): string =>
  [
    ...new Set(
      (s ?? '')
        .split(' · ')
        .filter(Boolean)
        .map((t) =>
          t === 'timer'
            ? 'a timer'
            : t.startsWith('person:')
              ? assigneeLabel(t.slice(7)) || 'an approver'
              : t.startsWith('event:')
                ? eventShort(t.slice(6)) || 'an event'
                : t,
        ),
    ),
  ].join(', ');

/** A short, sayable reference that tells look-alike orders apart: "ord_mv65gsxyqcs34m" → "#qcs34m". */
export const orderRef = (id: string) => `#${id.slice(-6)}`;

/**
 * Engine log lines in operator words: drops ids ("ord_…", "cus_…") and names assignees in
 * parentheses, e.g. "(sales_ops)" → "(Sales ops)".
 */
export const plainLog = (s: string) =>
  s
    .replace(/\s*\bfor\s+cus_[\w-]+/g, '')
    .replace(/\s*\b(ord|cus|apr)_[\w-]+/g, '')
    .replace(/\(([a-z]+(?:_[a-z]+)+)\)/g, (_, slug: string) => `(${assigneeLabel(slug)})`)
    .replace(/\s{2,}/g, ' ')
    .trim();

/** A node's run time: "12ms", "12s", "3m", "2.5h", "4d". */
export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
