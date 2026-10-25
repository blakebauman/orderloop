import { BASE_CURRENCY } from '@orderloop/core';
import type { ChartConfig } from '@orderloop/ui/chart';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { lazy, Suspense, useState } from 'react';
import { Empty, Section } from '~/components/page';
import { count, money } from '~/lib/format';
import type { Performance } from '~/lib/metrics.server';

type Day = Performance['daily'][number];

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const base = (n: number) => money(n, BASE_CURRENCY);
const sum = (days: Day[], k: keyof Omit<Day, 'day'>) => days.reduce((a, d) => a + d[k], 0);

// Recharts arrives after the rest of the overview; until then each chart holds its height.
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

/** Per-day area charts over the last 7, 30 or 90 days: revenue, how orders ended, and money in and out. */
export function Trends({ daily }: { daily: Day[] }) {
  const [range, setRange] = useState<Range>(30);
  const days = daily.slice(-range);
  const revenue = sum(days, 'revenue');
  const collected = sum(days, 'collected');
  const refunded = sum(days, 'refunded');
  const ended = sum(days, 'completed') + sum(days, 'stopped') + sum(days, 'failed');
  return (
    <Section
      title="Trends"
      actions={
        <Segmented
          aria-label="Range"
          value={String(range)}
          onValueChange={(v) => setRange(Number(v) as Range)}
          className="text-xs"
        >
          {RANGES.map((r) => (
            <SegmentedItem key={r} value={String(r)} className="tabular">
              {`${r} days`}
            </SegmentedItem>
          ))}
        </Segmented>
      }
    >
      <div className="grid gap-3 xl:grid-cols-3">
        <Panel
          title="Revenue"
          figure={base(revenue)}
          summary={`${base(revenue)} from orders completed in the last ${range} days, in ${BASE_CURRENCY}.`}
        >
          {revenue ? (
            <Chart days={days} config={revenueConfig} format={base} />
          ) : (
            <Empty>{`No revenue in the last ${range} days.`}</Empty>
          )}
        </Panel>
        <Panel
          title="Orders ended"
          figure={count(ended)}
          summary={`${count(ended)} orders ended in the last ${range} days: ${count(sum(days, 'completed'))} completed, ${count(sum(days, 'stopped'))} declined or cancelled, ${count(sum(days, 'failed'))} failed or rolled back.`}
        >
          {ended ? (
            <Chart days={days} config={outcomeConfig} format={count} stacked />
          ) : (
            <Empty>{`No order has ended in the last ${range} days.`}</Empty>
          )}
        </Panel>
        <Panel
          title="Collected and refunded"
          figure={base(collected)}
          summary={`${base(collected)} collected and ${base(refunded)} refunded in the last ${range} days.`}
        >
          {collected || refunded ? (
            <Chart days={days} config={paymentsConfig} format={base} />
          ) : (
            <Empty>{`No payments in the last ${range} days.`}</Empty>
          )}
        </Panel>
      </div>
    </Section>
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
