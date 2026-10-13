import type { NodeStatus, OrderStatus } from '@orderloop/core';

export const STATUS_COLOR: Record<NodeStatus | OrderStatus, string> = {
  pending: 'var(--idle)',
  queued: 'var(--idle)',
  running: 'var(--run)',
  waiting: 'var(--wait)',
  succeeded: 'var(--ok)',
  completed: 'var(--ok)',
  failed: 'var(--bad)',
  skipped: 'var(--idle)',
  cancelled: 'var(--idle)',
  rolled_back: 'var(--undo)',
};

/** Display-only statuses the UI derives (an order "declined" by policy is stored as cancelled). */
const DERIVED_COLOR: Record<string, string> = { declined: 'var(--undo)' };

export const statusColor = (s: string | undefined) =>
  STATUS_COLOR[(s ?? 'pending') as NodeStatus] ?? DERIVED_COLOR[s ?? ''] ?? 'var(--idle)';

/** The status to show for an order: policy declines read "declined", not "cancelled". */
export const orderStatus = (status: string, id: string, declined?: Set<string> | string[]) =>
  status === 'cancelled' && (Array.isArray(declined) ? declined.includes(id) : declined?.has(id))
    ? 'declined'
    : status;

/** Sentence-case status for badges: "rolled_back" → "Rolled back". */
export const statusLabel = (s: string) => humanize(s);

/** Internal identifiers to operator words: "sales_ops" → "Sales ops", "net_30" → "Net 30". */
export function humanize(s: string | null | undefined) {
  if (!s) return '';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Whole quantities with thousands separators: 25000 → "25,000". */
export const count = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** "1 line" / "3 lines". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function money(n: number | null | undefined, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n ?? 0);
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
 * reads "Approve B2B order". Same waits then group together.
 */
export const waitLabel = (s: string | null | undefined): string =>
  (s ?? '')
    .split(' · ')
    .map((part) => cleanWait(part))
    .filter(Boolean)
    .join(' · ');

const cleanWait = (s: string) =>
  s
    .replace(/^Waiting for\s+/i, '')
    .replace(/\s+for\s+cus_[\w-]+/g, '')
    .replace(/\s*\b(ord|cus|apr)_[\w-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** A short, sayable reference that tells look-alike orders apart: "ord_mv65gsxyqcs34m" → "#qcs34m". */
export const orderRef = (id: string) => `#${id.slice(-6)}`;

/**
 * Engine log lines in operator words: drops ids ("ord_…", "cus_…") and humanizes role slugs in
 * parentheses, e.g. "(sales_ops)" → "(Sales ops)".
 */
export const plainLog = (s: string) =>
  s
    .replace(/\s*\bfor\s+cus_[\w-]+/g, '')
    .replace(/\s*\b(ord|cus|apr)_[\w-]+/g, '')
    .replace(/\(([a-z]+(?:_[a-z]+)+)\)/g, (_, slug: string) => `(${humanize(slug)})`)
    .replace(/\s{2,}/g, ' ')
    .trim();
