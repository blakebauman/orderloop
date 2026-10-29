import { ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import { Progress } from '@orderloop/ui/progress';
import { Separator } from '@orderloop/ui/separator';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Empty } from '~/components/page';
import { count, duration } from '~/lib/format';
import type { Performance as Figures } from '~/lib/metrics.server';
import { useNodes } from '~/lib/nodes';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Below this many ended orders a rate says more than the data does; show the counts instead. */
const MIN_FOR_RATE = 5;
/** Below this many runs the 95th percentile is just the slowest run. */
const MIN_FOR_P95 = 20;

/** How orders finish over the window, by commerce model, and where time goes. */
export function PerformanceDetail({ p }: { p: Figures }) {
  const nodes = useNodes();
  const slowest = p.nodes.slice(0, 6);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Panel title="Completion by commerce model">
        {p.completion.length ? (
          <ul className="flex flex-col">
            {p.completion.map((c, i) => {
              const enough = c.finished >= MIN_FOR_RATE;
              const rate = c.finished ? c.completed / c.finished : 0;
              return (
                <li key={c.model}>
                  {i ? <Separator className="my-3" /> : null}
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">
                      {ORDER_MODEL_LABELS[c.model as OrderModel] ?? c.model}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular">
                      {count(c.completed)} of {count(c.finished)} ended orders completed
                    </span>
                  </div>
                  {enough ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Progress
                        value={Math.round(rate * 100)}
                        aria-hidden="true"
                        className="flex-1 *:data-[slot=progress-indicator]:bg-ok"
                      />
                      <span className="w-10 text-right font-medium tabular">{pct(rate)}</span>
                    </div>
                  ) : (
                    <p className="mt-1 text-muted-foreground text-xs">Too few for a rate.</p>
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
