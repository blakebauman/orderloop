import { BASE_CURRENCY, ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import { Separator } from '@orderloop/ui/separator';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Empty } from '~/components/page';
import { count, duration, money } from '~/lib/format';
import type { Performance as Figures } from '~/lib/metrics.server';
import { useNodes } from '~/lib/nodes';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const base = (n: number) => money(n, BASE_CURRENCY);

/** Below this many ended orders a rate says more than the data does; show the counts instead. */
const MIN_FOR_RATE = 5;
/** Below this many runs the 95th percentile is just the slowest run. */
const MIN_FOR_P95 = 20;

/** How orders finish over the window, what share of money was refunded, and where time goes. */
export function PerformanceDetail({ p }: { p: Figures }) {
  const nodes = useNodes();
  const slowest = p.nodes.slice(0, 6);
  const { collected, refunded } = p.totals;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {/* The one figure first, as its own card; then the two that need reading row by row. */}
      <Card size="sm" className="min-w-0">
        <CardHeader className="gap-1">
          <CardDescription>
            <h3>Refund rate</h3>
          </CardDescription>
          <CardTitle className="font-semibold text-2xl tabular max-md:text-xl">
            {collected ? pct(refunded / collected) : '—'}
          </CardTitle>
          <CardDescription className="text-xs tabular">
            {base(refunded)} refunded of {base(collected)} collected in the period, from orders in
            any state
          </CardDescription>
        </CardHeader>
      </Card>

      <Panel title="Completion by commerce model">
        {p.completion.length ? (
          <ul className="flex flex-col">
            {p.completion.map((c, i) => {
              const enough = c.finished >= MIN_FOR_RATE;
              const rate = c.finished ? c.completed / c.finished : 0;
              return (
                <li key={c.model}>
                  {i ? <Separator className="my-2.5" /> : null}
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate text-muted-foreground">
                      {ORDER_MODEL_LABELS[c.model as OrderModel] ?? c.model}
                    </span>
                    <span className="font-semibold tabular">
                      {enough ? pct(rate) : `${c.completed} of ${c.finished}`}
                    </span>
                  </div>
                  {enough ? (
                    <>
                      <div className="mt-1.5 h-1.5 rounded-full bg-muted" aria-hidden="true">
                        <div className="h-1.5 rounded-full bg-ok" style={{ width: pct(rate) }} />
                      </div>
                      <div className="mt-1 text-muted-foreground text-xs tabular">
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
          <Empty>{`No order ended in the last ${p.days} days.`}</Empty>
        )}
      </Panel>

      <Panel
        title="Slowest steps, waits included"
        flush={slowest.length > 0}
        note={
          slowest.length
            ? `Typical is the median; slow is the 95th percentile, shown from ${MIN_FOR_P95} runs.`
            : undefined
        }
      >
        {slowest.length ? (
          <Table caption="Slowest steps, waits included">
            <TableHead>
              <Tr>
                <Th>Step</Th>
                <Th numeric>Typical</Th>
                <Th numeric>Slow</Th>
              </Tr>
            </TableHead>
            <TableBody>
              {slowest.map((n) => (
                <Tr key={n.type}>
                  <Td title={n.type}>
                    {nodes.spec(n.type)?.label ?? n.type}
                    <span className="block text-muted-foreground text-xs">
                      {count(n.n)} {n.n === 1 ? 'run' : 'runs'}
                    </span>
                  </Td>
                  <Td numeric className="text-muted-foreground text-xs">
                    {duration(n.p50)}
                  </Td>
                  <Td numeric className="font-medium">
                    {n.n >= MIN_FOR_P95 ? (
                      duration(n.p95)
                    ) : (
                      <span className="font-normal text-muted-foreground text-xs">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>No timed runs yet.</Empty>
        )}
      </Panel>
    </div>
  );
}

/**
 * A card read row by row. `flush` runs a table to the card's edges under a rule; `note` says how
 * to read it, under the title.
 */
function Panel({
  title,
  note,
  flush,
  children,
}: {
  title: string;
  note?: string;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm" className={flush ? 'min-w-0 pb-0' : 'min-w-0'}>
      <CardHeader>
        <CardTitle className="section-title">
          <h3>{title}</h3>
        </CardTitle>
        {note ? <CardDescription className="text-xs">{note}</CardDescription> : null}
      </CardHeader>
      {flush ? (
        <div className="min-w-0 border-t">{children}</div>
      ) : (
        <CardContent>{children}</CardContent>
      )}
    </Card>
  );
}
