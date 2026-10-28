/**
 * The Trends section's chart, loaded on its own (trends.tsx imports it lazily) so Recharts isn't in
 * the overview's first download.
 */

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@orderloop/ui/chart';
import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import type { Performance } from '~/lib/metrics.server';

type Day = Performance['daily'][number];

// Days are UTC dates; label them in UTC so the server and the browser agree.
const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: unknown) => short.format(new Date(`${day}T00:00:00Z`));

/** One area per series in `config`, filled with a fade to the baseline. */
export default function Chart({
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
    <ChartContainer config={config} className="aspect-auto h-44 w-full" aria-hidden="true">
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
            and solid tints, so each band reads against the one under it. Only the base band has an
            outline: a band's stroke runs along the stack's top, so on the top band (failed) it
            would draw a red line every day, failures or not. */}
        {keys.map((k, i) => (
          <Area
            key={k}
            dataKey={k}
            type={stacked ? 'linear' : 'monotone'}
            stroke={`var(--color-${k})`}
            strokeWidth={stacked && i > 0 ? 0 : 1.5}
            // Two greys alone are hard to tell apart; the lesser money series is dashed.
            strokeDasharray={k === 'refunded' ? '4 3' : undefined}
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
