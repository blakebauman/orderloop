/**
 * The Performance page's figures over one window of whole UTC days, aggregated in D1: the daily
 * series (revenue, money collected and refunded, orders ended by outcome), completion rate by order
 * type, and p50 and p95 duration per node type (from `node_runs`, which the OrderAgent writes as
 * runs finish). Money is in the base currency, at each order's rate.
 */

import { TERMINAL_ORDER_STATUSES } from '@orderloop/core';
import { nodeRuns, orders, payments } from '@orderloop/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from './env.server';
import type { Range } from './ranges';

const DAY = 86_400_000;

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

export type Day = {
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

/** The first instant of the window: midnight UTC, `days - 1` days before today's. */
export function windowStart(days: number, now = Date.now()): number {
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  return today - (days - 1) * DAY;
}

/** The window's figures, summed from its days, so a total and its chart can never disagree. */
export function totals(daily: Day[]): Day {
  return daily.reduce(
    (t, d) => ({
      revenue: t.revenue + d.revenue,
      collected: t.collected + d.collected,
      refunded: t.refunded + d.refunded,
      completed: t.completed + d.completed,
      stopped: t.stopped + d.stopped,
      failed: t.failed + d.failed,
    }),
    EMPTY_DAY,
  );
}

/**
 * Everything the Performance page shows, over one window of whole UTC days ending today: every
 * figure counts the same orders and payments, and the totals are the sums of the daily series.
 * An ended order counts on the day it ended (its last update).
 */
export async function performance(days: Range = 30, now = Date.now()) {
  const since = windowStart(days, now);
  const dayOf = (ms: unknown) => sql<string>`date(${ms} / 1000, 'unixepoch')`;
  const ended = and(inArray(orders.status, TERMINAL_ORDER_STATUSES), gte(orders.updatedAt, since));
  const [completion, nodes, revenue, money, endings] = await Promise.all([
    db()
      .select({
        model: orders.model,
        finished: sql<number>`count(*)`,
        completed: sql<number>`sum(${orders.status} = 'completed')`,
      })
      .from(orders)
      .where(ended)
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
      .where(and(eq(orders.status, 'completed'), gte(orders.updatedAt, since)))
      .groupBy(sql`1`),
    // Payments are in their order's currency; convert at the order's rate.
    db()
      .select({
        day: dayOf(payments.createdAt),
        collected: sql<number>`coalesce(sum(case when ${payments.kind} in ('capture', 'charge') then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`,
        refunded: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then ${payments.amount} / coalesce(${orders.fxRate}, 1) end), 0)`,
      })
      .from(payments)
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.status, 'succeeded'), gte(payments.createdAt, since)))
      .groupBy(sql`1`),
    db()
      .select({ day: dayOf(orders.updatedAt), status: orders.status, n: sql<number>`count(*)` })
      .from(orders)
      .where(ended)
      .groupBy(sql`1`, orders.status),
  ]);

  const byDay = new Map<string, Partial<Day>>();
  const at = (day: string) => byDay.get(day) ?? byDay.set(day, {}).get(day)!;
  for (const r of revenue) at(r.day).revenue = r.total;
  for (const r of money) Object.assign(at(r.day), { collected: r.collected, refunded: r.refunded });
  for (const r of endings) {
    const d = at(r.day);
    const k = OUTCOME[r.status];
    if (k) d[k] = (d[k] ?? 0) + r.n;
  }
  const daily = fillDays(byDay, days, EMPTY_DAY, now);
  return { days, since, completion, nodes, daily, totals: totals(daily) };
}
