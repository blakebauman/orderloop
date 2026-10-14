/**
 * Dashboard performance figures over a trailing window, aggregated in D1: completion rate by order
 * type, p50 and p95 duration per node type (from `node_runs`, which the OrderAgent writes as runs
 * finish), revenue per day and refund rate. Money is in the base currency, at each order's rate.
 */

import { TERMINAL_ORDER_STATUSES } from '@orderloop/core';
import { nodeRuns, orders, payments } from '@orderloop/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from './env.server';

const DAY = 86_400_000;

export type Performance = Awaited<ReturnType<typeof performance>>;

export async function performance(days = 30, now = Date.now()) {
  const since = now - days * DAY;
  const [completion, nodes, revenue, paid] = await Promise.all([
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
        day: sql<string>`date(${orders.updatedAt} / 1000, 'unixepoch')`,
        total: sql<number>`sum(${orders.total} / ${orders.fxRate})`,
      })
      .from(orders)
      .where(and(eq(orders.status, 'completed'), gte(orders.updatedAt, since)))
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
  ]);

  // One entry per day, oldest first, so days without revenue still show.
  const byDay = new Map(revenue.map((r) => [r.day, r.total]));
  const perDay = Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10);
    return { day, total: byDay.get(day) ?? 0 };
  });

  return {
    days,
    completion,
    nodes,
    revenue: perDay,
    collected: paid?.collected ?? 0,
    refunded: paid?.refunded ?? 0,
  };
}
