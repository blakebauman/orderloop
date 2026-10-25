import { BASE_CURRENCY } from '@orderloop/core';
import type { ChartConfig } from '@orderloop/ui/chart';
import { lazy, Suspense } from 'react';
import { Empty } from '~/components/page';
import { count, money } from '~/lib/format';
import type { Performance } from '~/lib/metrics.server';

const base = (n: number) => money(n, BASE_CURRENCY);

// Recharts arrives after the rest of the page; until then each chart holds its height.
const LazyChart = lazy(() => import('./trends-chart'));
const Chart = (props: React.ComponentProps<typeof LazyChart>) => (
  <Suspense fallback={<div className="mt-3 h-44" aria-hidden="true" />}>
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

/** Per-day area charts over the window: revenue, how orders ended, and money in and out. */
export function Trends({ daily, totals, days }: Pick<Performance, 'daily' | 'totals' | 'days'>) {
  const { revenue, collected, refunded, completed, stopped, failed } = totals;
  const ended = completed + stopped + failed;
  const period = `in the last ${days} days`;
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <Panel
        title="Revenue"
        figure={base(revenue)}
        summary={`${base(revenue)} from orders completed ${period}, in ${BASE_CURRENCY}.`}
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
        summary={`${count(ended)} orders ended ${period}: ${count(completed)} completed, ${count(stopped)} declined or cancelled, ${count(failed)} failed or rolled back.`}
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

function Panel({
  title,
  figure,
  summary,
  children,
}: {
  title: string;
  figure: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div className="tile min-w-0 p-4">
      <h3 className="caption">{title}</h3>
      <div className="font-semibold text-xl tabular">{figure}</div>
      <p className="sr-only">{summary}</p>
      {children}
    </div>
  );
}
