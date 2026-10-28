'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';

import { cn } from './lib/utils';

/** Series by data key: its label and its color, a CSS value such as `var(--ok)`. */
export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error('useChart must be used within a <ChartContainer />');
  return context;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/60 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-layer]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

/** Exposes each series' color as `--color-<key>` inside this chart. */
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colors = Object.entries(config).filter(([, c]) => c.color);
  if (!colors.length) return null;
  const rules = colors.map(([key, c]) => `  --color-${key}: ${c.color};`).join('\n');
  return <style dangerouslySetInnerHTML={{ __html: `[data-chart=${id}] {\n${rules}\n}` }} />;
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type Item = {
  dataKey?: string | number | ((obj: unknown) => unknown);
  name?: string | number;
  value?: unknown;
  color?: string;
  payload?: Record<string, unknown>;
};

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter = (v) => String(v),
  hideLabel = false,
  className,
}: {
  active?: boolean;
  payload?: readonly Item[];
  label?: React.ReactNode;
  labelFormatter?: (label: React.ReactNode, payload: readonly Item[]) => React.ReactNode;
  valueFormatter?: (value: number, key: string) => React.ReactNode;
  hideLabel?: boolean;
  className?: string;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  return (
    <div
      className={cn(
        'grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-popover px-2.5 py-1.5 text-popover-foreground text-xs shadow-xl',
        className,
      )}
    >
      {hideLabel ? null : (
        <div className="font-medium">{labelFormatter ? labelFormatter(label, payload) : label}</div>
      )}
      <div className="grid gap-1">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? 'value');
          const series = config[key];
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: item.color ?? `var(--color-${key})` }}
              />
              <span className="flex-1 text-muted-foreground">{series?.label ?? item.name}</span>
              <span className="font-medium tabular">{valueFormatter(Number(item.value), key)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
  payload,
  className,
}: {
  payload?: readonly { dataKey?: unknown; value?: unknown; color?: string }[];
  className?: string;
}) {
  const { config } = useChart();
  if (!payload?.length) return null;
  // Recharts sorts legend items by key; list them in the config's order, as the tooltip does.
  const keyOf = (item: (typeof payload)[number]) => String(item.dataKey ?? item.value ?? 'value');
  const order = Object.keys(config);
  const items = [...payload].sort((x, y) => order.indexOf(keyOf(x)) - order.indexOf(keyOf(y)));
  return (
    <div
      className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3', className)}
    >
      {items.map((item) => {
        const key = keyOf(item);
        return (
          <div key={key} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: item.color ?? `var(--color-${key})` }}
            />
            {config[key]?.label ?? String(item.value)}
          </div>
        );
      })}
    </div>
  );
}

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
  useChart,
};
