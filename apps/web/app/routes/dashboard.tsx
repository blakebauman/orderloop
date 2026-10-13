import { ORDER_TYPE_LABELS, type OrderType } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { ArrowRight, Play } from 'lucide-react';
import { Form, Link, redirect, useLoaderData, useNavigation } from 'react-router';
import { Empty, PageHeader, Section, Stat } from '~/components/page';
import { StatusBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded } from '~/lib/flows.server';
import { ago, money, STATUS_COLOR, shortId } from '~/lib/format';
import { dashboardStats, listOrders } from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/dashboard';

export const meta = () => [{ title: 'Overview · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  await ensureSeeded();
  const [stats, recent] = await Promise.all([dashboardStats(), listOrders({}, 12)]);
  return { stats, recent };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const form = await request.formData();
  const sc = SCENARIOS.find((s) => s.id === form.get('scenario'));
  if (!sc) return { error: 'Unknown scenario' };
  await ensureSeeded();
  const { orderId } = await engine().startOrder({ flowId: sc.flowId, input: sc.input });
  return redirect(`/orders/${orderId}`);
}

export default function Dashboard() {
  const { stats, recent } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const count = (s: string[]) =>
    stats.byStatus.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  const completedValue = stats.byStatus.find((r) => r.status === 'completed')?.total ?? 0;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Every order runs as a durable loop: a flow graph interpreted by Cloudflare Workflows, with one agent per order."
        actions={
          <Button asChild>
            <Link to="/orders/new">New order</Link>
          </Button>
        }
      />
      <div className="mx-auto max-w-[1400px] space-y-8 px-6 pb-10">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat
            label="In flight"
            value={count(['queued', 'running'])}
            tone={STATUS_COLOR.running}
          />
          <Stat
            label="Waiting"
            value={count(['waiting'])}
            hint={`${stats.pendingApprovals} approvals pending`}
            tone={STATUS_COLOR.waiting}
          />
          <Stat
            label="Completed"
            value={count(['completed'])}
            hint={money(completedValue)}
            tone={STATUS_COLOR.completed}
          />
          <Stat label="Cancelled" value={count(['cancelled'])} />
          <Stat
            label="Failed / rolled back"
            value={count(['failed', 'rolled_back'])}
            tone={STATUS_COLOR.rolled_back}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Section
            title="Recent orders"
            actions={
              <Link to="/orders" className="text-primary text-xs hover:underline">
                All orders
              </Link>
            }
          >
            {recent.length ? (
              <ul className="-my-2 divide-y">
                {recent.map((o) => (
                  <li key={o.id}>
                    <Link
                      to={`/orders/${o.id}`}
                      className="flex items-center gap-3 py-2.5 hover:opacity-90"
                    >
                      <StatusBadge status={o.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">
                          {o.title || ORDER_TYPE_LABELS[o.type as OrderType]}
                        </div>
                        <div className="truncate text-muted-foreground text-xs">
                          <span className="font-mono">{shortId(o.id)}</span> ·{' '}
                          {ORDER_TYPE_LABELS[o.type as OrderType]}
                          {o.waitingOn ? ` · waiting on ${o.waitingOn}` : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm tabular">{money(o.total, o.currency)}</div>
                        <div className="text-muted-foreground text-xs">{ago(o.updatedAt)}</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No orders yet. Start one of the demo scenarios →</Empty>
            )}
          </Section>

          <Section title="Run a scenario">
            <div className="-my-1 space-y-1">
              {SCENARIOS.map((s) => (
                <Form method="post" key={s.id}>
                  <input type="hidden" name="scenario" value={s.id} />
                  <button
                    type="submit"
                    disabled={nav.state !== 'idle'}
                    className="group flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
                  >
                    <Play className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-sm">{s.label}</span>
                      <span className="block text-muted-foreground text-xs leading-snug">
                        {s.blurb}
                      </span>
                    </span>
                    <ArrowRight className="mt-0.5 size-3.5 opacity-0 transition group-hover:opacity-60" />
                  </button>
                </Form>
              ))}
            </div>
          </Section>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(Object.keys(ORDER_TYPE_LABELS) as OrderType[]).map((t) => (
            <Link
              key={t}
              to={`/orders?type=${t}`}
              className="rounded-md border bg-card px-4 py-3 hover:border-primary/40"
            >
              <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                {ORDER_TYPE_LABELS[t]}
              </div>
              <div className="mt-1 font-semibold text-xl tabular">
                {stats.byType.find((r) => r.type === t)?.n ?? 0}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
