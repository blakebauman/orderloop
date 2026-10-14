import { nodeSpec, ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Empty, Section } from '~/components/page';
import { duration, money } from '~/lib/format';
import type { Performance as Figures } from '~/lib/metrics.server';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The trailing-window figures: how orders finish, what they earn and refund, and where time goes. */
export function Performance({ p }: { p: Figures }) {
  const revenue = p.revenue.reduce((a, d) => a + d.total, 0);
  const peak = Math.max(...p.revenue.map((d) => d.total), 0);
  const slowest = p.nodes.slice(0, 6);
  return (
    <Section title={`Last ${p.days} days`} flush>
      <div className="grid gap-px bg-[var(--rule)] md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Completion by commerce model">
          {p.completion.length ? (
            <ul className="space-y-2">
              {p.completion.map((c) => {
                const rate = c.finished ? c.completed / c.finished : 0;
                return (
                  <li key={c.model}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">
                        {ORDER_MODEL_LABELS[c.model as OrderModel] ?? c.model}
                      </span>
                      <span className="font-medium tabular">{pct(rate)}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden="true">
                      <div className="h-1 rounded-full bg-ok" style={{ width: pct(rate) }} />
                    </div>
                    <div className="mt-0.5 text-muted-foreground text-xs tabular">
                      {c.completed} of {c.finished} finished
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>No order has finished yet.</Empty>
          )}
        </Panel>

        <Panel title="Revenue">
          <div className="font-semibold text-xl tabular">{money(revenue)}</div>
          <div className="text-muted-foreground text-xs">from completed orders</div>
          <div
            className="mt-3 flex h-12 items-end gap-px"
            role="img"
            aria-label={`Revenue per day over the last ${p.days} days, peaking at ${money(peak)}`}
          >
            {p.revenue.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${money(d.total)}`}
                className="min-w-0 flex-1 rounded-sm bg-foreground/70"
                style={{ height: peak ? `${Math.max(4, (d.total / peak) * 100)}%` : '4%' }}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Refund rate">
          <div className="font-semibold text-xl tabular">
            {p.collected ? pct(p.refunded / p.collected) : '—'}
          </div>
          <div className="text-muted-foreground text-xs tabular">
            {money(p.refunded)} refunded of {money(p.collected)} collected
          </div>
        </Panel>

        <Panel title="Slowest steps">
          {slowest.length ? (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="pb-1 text-left font-normal">Step</th>
                  <th className="pb-1 text-right font-normal">
                    <abbr title="Median">p50</abbr>
                  </th>
                  <th className="pb-1 pl-2 text-right font-normal">
                    <abbr title="95th percentile">p95</abbr>
                  </th>
                </tr>
              </thead>
              <tbody>
                {slowest.map((n) => (
                  <tr key={n.type}>
                    <td className="truncate py-0.5 pr-2" title={`${n.type}, ${n.n} runs`}>
                      {nodeSpec(n.type)?.label ?? n.type}
                    </td>
                    <td className="py-0.5 text-right text-muted-foreground text-xs tabular">
                      {duration(n.p50)}
                    </td>
                    <td className="py-0.5 pl-2 text-right font-medium tabular">
                      {duration(n.p95)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No timed runs yet.</Empty>
          )}
        </Panel>
      </div>
    </Section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <h3 className="mb-3 text-muted-foreground text-xs">{title}</h3>
      {children}
    </div>
  );
}
