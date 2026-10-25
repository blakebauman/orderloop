import { BASE_CURRENCY } from '@orderloop/core';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@orderloop/ui/chart';
import { useId, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import { Empty, Section } from '~/components/page';
import { count, money } from '~/lib/format';
import type { Performance } from '~/lib/metrics.server';

type Day = Performance['daily'][number];

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const base = (n: number) => money(n, BASE_CURRENCY);
const sum = (days: Day[], k: keyof Omit<Day, 'day'>) => days.reduce((a, d) => a + d[k], 0);

// Days are UTC dates; label them in UTC so the server and the browser agree.
const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: unknown) => short.format(new Date(`${day}T00:00:00Z`));

const revenueConfig = { revenue: { label: 'Revenue', color: 'var(--ink)' } } satisfies ChartConfig;
const outcomeConfig = {
  completed: { label: 'Completed', color: 'var(--ok)' },
  stopped: { label: 'Declined or cancelled', color: 'var(--idle)' },
  failed: { label: 'Failed or rolled back', color: 'var(--bad)' },
} satisfies ChartConfig;
const paymentsConfig = {
  collected: { label: 'Collected', color: 'var(--link)' },
  refunded: { label: 'Refunded', color: 'var(--undo)' },
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
      flush
      actions={
        <fieldset className="flex rounded-full bg-muted p-1 text-xs">
          <legend className="sr-only">Range</legend>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className="rounded-full px-2.5 py-1 text-muted-foreground tabular hover:text-foreground aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-sm dark:aria-pressed:bg-input/30"
            >
              {`${r} days`}
            </button>
          ))}
        </fieldset>
      }
    >
      <div className="grid gap-px bg-[var(--rule)] xl:grid-cols-3">
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
    <div className="min-w-0 bg-card p-4">
      <h3 className="text-muted-foreground text-xs">{title}</h3>
      <div className="font-semibold text-xl tabular">{figure}</div>
      <p className="sr-only">{summary}</p>
      {children}
    </div>
  );
}

/** One area per series in `config`, filled with a fade to the baseline. */
function Chart({
  days,
  config,
  format,
  stacked = false,
}: {
  days: Day[];
  config: ChartConfig;
  format: (n: number) => string;
  stacked?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const keys = Object.keys(config);
  return (
    <ChartContainer config={config} className="mt-3 aspect-auto h-44 w-full" aria-hidden="true">
      <AreaChart data={days} margin={{ left: 4, right: 4, top: 4 }} accessibilityLayer={false}>
        <defs>
          {keys.map((k) => (
            <linearGradient key={k} id={`${id}-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.35} />
              <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.03} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="var(--rule)" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          tickFormatter={dayLabel}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(l) => dayLabel(l)}
              valueFormatter={(v) => format(v)}
            />
          }
        />
        {/* Stacked bands are counts: straight segments, so no curve swings past a day's value,
            and solid tints, so each band reads against the one under it. */}
        {keys.map((k) => (
          <Area
            key={k}
            dataKey={k}
            type={stacked ? 'linear' : 'monotone'}
            stroke={`var(--color-${k})`}
            strokeWidth={1.5}
            fill={stacked ? `var(--color-${k})` : `url(#${id}-${k})`}
            fillOpacity={stacked ? 0.4 : 1}
            stackId={stacked ? 'a' : undefined}
            isAnimationActive={false}
          />
        ))}
        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  );
}
