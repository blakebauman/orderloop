import { BASE_CURRENCY, ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Empty, Section } from '~/components/page';
import { count, duration, money } from '~/lib/format';
import type { Performance as Figures } from '~/lib/metrics.server';
import { useNodes } from '~/lib/nodes';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const base = (n: number) => money(n, BASE_CURRENCY);

/** Below this many ended orders a rate says more than the data does; show the counts instead. */
const MIN_FOR_RATE = 5;
/** Below this many runs the 95th percentile is just the slowest run. */
const MIN_FOR_P95 = 20;

/** The trailing-window figures: how orders finish, what they earn and refund, and where time goes. */
export function Performance({ p }: { p: Figures }) {
  const nodes = useNodes();
  const revenue = p.revenue.reduce((a, d) => a + d.total, 0);
  const peak = p.revenue.reduce((a, d) => (d.total > a.total ? d : a), { day: '', total: 0 });
  const earning = p.revenue.filter((d) => d.total > 0).length;
  const slowest = p.nodes.slice(0, 6);
  return (
    <Section title={`Last ${p.days} days`}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Completion by commerce model">
          {p.completion.length ? (
            <ul className="space-y-2">
              {p.completion.map((c) => {
                const enough = c.finished >= MIN_FOR_RATE;
                const rate = c.finished ? c.completed / c.finished : 0;
                return (
                  <li key={c.model}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">
                        {ORDER_MODEL_LABELS[c.model as OrderModel] ?? c.model}
                      </span>
                      <span className="font-medium tabular">
                        {enough ? pct(rate) : `${c.completed} of ${c.finished}`}
                      </span>
                    </div>
                    {enough ? (
                      <>
                        <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden="true">
                          <div className="h-1 rounded-full bg-ok" style={{ width: pct(rate) }} />
                        </div>
                        <div className="mt-0.5 text-muted-foreground text-xs tabular">
                          {count(c.completed)} of {count(c.finished)} ended orders completed
                        </div>
                      </>
                    ) : (
                      <div className="mt-0.5 text-muted-foreground text-xs">
                        ended orders completed; too few for a rate
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>No order has finished yet.</Empty>
          )}
        </Panel>

        <Panel title="Revenue">
          <div className="font-semibold text-xl tabular">{base(revenue)}</div>
          <div className="text-muted-foreground text-xs">
            from orders completed in the period, in {BASE_CURRENCY}
          </div>
          <p className="mt-2 text-muted-foreground text-xs">
            {earning
              ? `Revenue on ${earning} of ${p.days} days; the most, ${base(peak.total)}, on ${peak.day}.`
              : `No revenue in the last ${p.days} days.`}
          </p>
        </Panel>

        <Panel title="Refund rate">
          <div className="font-semibold text-xl tabular">
            {p.collected ? pct(p.refunded / p.collected) : '—'}
          </div>
          <div className="text-muted-foreground text-xs tabular">
            {base(p.refunded)} refunded of {base(p.collected)} collected in the period, from orders
            in any state
          </div>
        </Panel>

        <Panel title="Slowest steps, waits included">
          {slowest.length ? (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="pb-1 text-left font-normal">
                    Step
                  </th>
                  <th scope="col" className="pb-1 pl-2 text-right font-normal">
                    Typical
                  </th>
                  <th scope="col" className="pb-1 pl-2 text-right font-normal">
                    Slow
                  </th>
                </tr>
              </thead>
              <tbody>
                {slowest.map((n) => (
                  <tr key={n.type}>
                    <td className="py-0.5 pr-2" title={n.type}>
                      {nodes.spec(n.type)?.label ?? n.type}
                      <span className="block text-muted-foreground text-xs tabular">
                        {count(n.n)} {n.n === 1 ? 'run' : 'runs'}
                      </span>
                    </td>
                    <td className="py-0.5 pl-2 text-right align-top text-muted-foreground text-xs tabular">
                      {duration(n.p50)}
                    </td>
                    <td className="py-0.5 pl-2 text-right align-top font-medium tabular">
                      {n.n >= MIN_FOR_P95 ? (
                        duration(n.p95)
                      ) : (
                        <span className="font-normal text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No timed runs yet.</Empty>
          )}
          {slowest.length ? (
            <p className="mt-2 text-muted-foreground text-xs">
              Typical is the median; slow is the 95th percentile, shown from {MIN_FOR_P95} runs.
            </p>
          ) : null}
        </Panel>
      </div>
    </Section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="tile min-w-0 p-4">
      <h3 className="caption mb-3">{title}</h3>
      {children}
    </div>
  );
}
