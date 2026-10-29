import { BASE_CURRENCY } from '@orderloop/core';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@orderloop/ui/card';
import type { ChartConfig } from '@orderloop/ui/chart';
import { cn } from '@orderloop/ui/lib/utils';
import { lazy, Suspense } from 'react';
import { Empty } from '~/components/page';
import { count, money, plural } from '~/lib/format';
import type { Performance } from '~/lib/metrics.server';

const base = (n: number) => money(n, BASE_CURRENCY);

// Recharts arrives after the rest of the page; until then each chart holds its height.
const LazyChart = lazy(() => import('./trends-chart'));
const Chart = (props: React.ComponentProps<typeof LazyChart>) => (
  <Suspense fallback={<div className="h-44" aria-hidden="true" />}>
    <LazyChart {...props} />
  </Suspense>
);

// Money draws in the preset's neutral ramp; the outcome chart keeps the status colours, so a failure
// still reads as one.
const revenueConfig = {
  revenue: { label: 'Revenue', color: 'var(--chart-5)' },
} satisfies ChartConfig;
const outcomeConfig = {
  completed: { label: 'Completed', color: 'var(--ok)' },
  stopped: { label: 'Declined or cancelled', color: 'var(--idle)' },
  failed: { label: 'Failed or rolled back', color: 'var(--bad)' },
} satisfies ChartConfig;
const paymentsConfig = {
  collected: { label: 'Collected', color: 'var(--chart-5)' },
  refunded: { label: 'Refunded', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Per-day area charts over the window: revenue, how orders ended, and money in and out. Each card
 * ends in the figures its chart adds up to (shadcn's power-usage card).
 */
export function Trends({ daily, totals, days }: Pick<Performance, 'daily' | 'totals' | 'days'>) {
  const { revenue, collected, refunded, completed, stopped, failed } = totals;
  const ended = completed + stopped + failed;
  const period = `in the last ${days} days`;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Panel
        title="Revenue"
        figure={base(revenue)}
        summary={`${base(revenue)} from orders completed ${period}, in ${BASE_CURRENCY}.`}
        stats={
          revenue
            ? [
                { label: 'Completed orders', value: count(completed) },
                {
                  label: 'Per completed order',
                  value: completed ? base(revenue / completed) : '—',
                },
              ]
            : undefined
        }
      >
        {revenue ? (
          <Chart days={daily} config={revenueConfig} format={base} />
        ) : (
          <Empty>{`No revenue ${period}.`}</Empty>
        )}
      </Panel>
      <Panel
        title="Orders ended"
        figure={count(ended)}
        summary={`${plural(ended, 'order')} ended ${period}: ${count(completed)} completed, ${count(stopped)} declined or cancelled, ${count(failed)} failed or rolled back.`}
        stats={
          ended
            ? [
                { label: 'Completed', value: count(completed) },
                { label: 'Declined or cancelled', value: count(stopped) },
                { label: 'Failed or rolled back', value: count(failed), bad: failed > 0 },
              ]
            : undefined
        }
      >
        {ended ? (
          <Chart days={daily} config={outcomeConfig} format={count} stacked />
        ) : (
          <Empty>{`No order has ended ${period}.`}</Empty>
        )}
      </Panel>
      <Panel
        title="Collected and refunded"
        figure={base(collected)}
        summary={`${base(collected)} collected and ${base(refunded)} refunded ${period}.`}
        stats={
          collected || refunded
            ? [
                { label: 'Refunded', value: base(refunded) },
                { label: 'Refund rate', value: collected ? pct(refunded / collected) : '—' },
              ]
            : undefined
        }
        note={collected || refunded ? 'Refunds count from orders in any state.' : undefined}
      >
        {collected || refunded ? (
          <Chart days={daily} config={paymentsConfig} format={base} />
        ) : (
          <Empty>{`No payments ${period}.`}</Empty>
        )}
      </Panel>
    </div>
  );
}

type Stat = { label: string; value: string; bad?: boolean };

/**
 * One window figure as a card (the preview cards' stock tile and power usage): its label, the
 * figure set large, the chart that adds up to it, and under a rule the figures it breaks into
 * (left out while there is nothing to chart).
 */
function Panel({
  title,
  figure,
  summary,
  stats,
  note,
  children,
}: {
  title: string;
  figure: string;
  summary: string;
  stats?: Stat[];
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader className="gap-1">
        <CardDescription>
          <h3>{title}</h3>
        </CardDescription>
        <CardTitle className="font-semibold text-2xl tabular max-md:text-xl">{figure}</CardTitle>
        <p className="sr-only">{summary}</p>
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
      {stats ? (
        <CardFooter className="flex-col items-stretch gap-2 border-t">
          <dl className={cn('grid gap-3', stats.length > 2 ? 'grid-cols-3' : 'grid-cols-2')}>
            {stats.map((s) => (
              <div key={s.label} className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs">{s.label}</dt>
                <dd className={cn('font-semibold tabular', s.bad && 'text-bad')}>{s.value}</dd>
              </div>
            ))}
          </dl>
          {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}
