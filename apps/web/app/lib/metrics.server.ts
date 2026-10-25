/**
 * Dashboard performance figures over a trailing window, aggregated in D1: completion rate by order
 * type, p50 and p95 duration per node type (from `node_runs`, which the OrderAgent writes as runs
 * finish), revenue per day and refund rate. Money is in the base currency, at each order's rate.
 * `daily` is a longer per-day series for the dashboard's charts: revenue, money collected and refunded,
 * and orders ended by outcome.
 */

import { TERMINAL_ORDER_STATUSES } from '@orderloop/core';
import { nodeRuns, orders, payments } from '@orderloop/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from './env.server';

const DAY = 86_400_000;
/** How far back the dashboard's charts can look. */
export const SERIES_DAYS = 90;

/** One row per UTC day, oldest first, ending today, so days with nothing still show. */
export function fillDays<T extends object>(
  rows: Map<string, Partial<T>>,
  days: number,
  empty: T,
  now = Date.now(),
): (T & { day: string })[] {
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    return { ...empty, ...rows.get(day), day };
  });
}

/** How an ended order counts in the outcome chart. */
const OUTCOME: Record<string, 'completed' | 'stopped' | 'failed'> = {
  completed: 'completed',
  declined: 'stopped',
  cancelled: 'stopped',
  failed: 'failed',
  rolled_back: 'failed',
};

export type Performance = Awaited<ReturnType<typeof performance>>;

type Day = {
  revenue: number;
  collected: number;
  refunded: number;
  completed: number;
  stopped: number;
  failed: number;
};
const EMPTY_DAY: Day = {
  revenue: 0,
  collected: 0,
  refunded: 0,
  completed: 0,
  stopped: 0,
  failed: 0,
};

export async function performance(days = 30, now = Date.now()) {
  const since = now - days * DAY;
  const seriesSince = now - Math.max(days, SERIES_DAYS) * DAY;
  const dayOf = (ms: unknown) => sql<string>`date(${ms} / 1000, 'unixepoch')`;
  const [completion, nodes, revenue, paid, money, ended] = await Promise.all([
    db()
      .select({
        model: orders.model,
        finished: sql<number>`count(*)`,
        completed: sql<number>`sum(${orders.status} = 'completed')`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, since), inArray(orders.status, TERMINAL_ORDER_STATUSES)))
      .groupBy(orders.model)
      .orderBy(sql`count(*) desc`),
    // Nearest-rank percentiles: the row at ceil(p × n) in each node type's sorted durations.
    db().all<{ type: string; n: number; p50: number; p95: number }>(sql`
      with ranked as (
        select ${nodeRuns.nodeType} as type, ${nodeRuns.durationMs} as ms,
          row_number() over (partition by ${nodeRuns.nodeType} order by ${nodeRuns.durationMs}) as rn,
          count(*) over (partition by ${nodeRuns.nodeType}) as n
        from ${nodeRuns}
        where ${nodeRuns.endedAt} >= ${since}
      )
      select type, n,
        max(case when rn = (n * 50 + 99) / 100 then ms end) as p50,
        max(case when rn = (n * 95 + 99) / 100 then ms end) as p95
      from ranked
      group by type
      order by p95 desc`),
    db()
      .select({
        day: dayOf(orders.updatedAt),
        total: sql<number>`sum(${orders.total} / ${orders.fxRate})`,
      })
      .from(orders)
      .where(and(eq(orders.status, 'completed'), gte(orders.updatedAt, seriesSince)))
      .groupBy(sql`1`),
    db()
      .select({
        collected: sql<number>`coalesce(sum(case when ${payments.kind} in ('capture', 'charge') then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`,
        refunded: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`,
      })
      .from(payments)
      // Payments are in their order's currency; convert at the order's rate.
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.status, 'succeeded'), gte(payments.createdAt, since)))
      .get(),
    db()
      .select({
        day: dayOf(payments.createdAt),
        collected: sql<number>`coalesce(sum(case when ${payments.kind} in ('capture', 'charge') then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`,
        refunded: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`,
      })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.status, 'succeeded'), gte(payments.createdAt, seriesSince)))
      .groupBy(sql`1`),
    // An ended order's last update is when it ended.
    db()
      .select({ day: dayOf(orders.updatedAt), status: orders.status, n: sql<number>`count(*)` })
      .from(orders)
      .where(
        and(inArray(orders.status, TERMINAL_ORDER_STATUSES), gte(orders.updatedAt, seriesSince)),
      )
      .groupBy(sql`1`, orders.status),
  ]);

  const byDay = new Map<string, Partial<Day>>();
  const at = (day: string) => byDay.get(day) ?? byDay.set(day, {}).get(day)!;
  for (const r of revenue) at(r.day).revenue = r.total;
  for (const r of money) Object.assign(at(r.day), { collected: r.collected, refunded: r.refunded });
  for (const r of ended) {
    const d = at(r.day);
    const k = OUTCOME[r.status];
    if (k) d[k] = (d[k] ?? 0) + r.n;
  }
  const daily = fillDays(byDay, Math.max(days, SERIES_DAYS), EMPTY_DAY, now);

  return {
    days,
    completion,
    nodes,
    revenue: daily.slice(-days).map((d) => ({ day: d.day, total: d.revenue })),
    daily,
    collected: paid?.collected ?? 0,
    refunded: paid?.refunded ?? 0,
  };
}
