import type { OrderState } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { RefreshCw, Zap } from 'lucide-react';
import { Form, Link, useFetcher, useLoaderData, useNavigation } from 'react-router';
import { Empty, PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { money, shortId } from '~/lib/format';
import { backOffice, waitingOrders } from '~/lib/orders.server';
import type { Route } from './+types/back-office';

export const meta = () => [{ title: 'Back office · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const [office, waiting] = await Promise.all([backOffice(), waitingOrders()]);
  const states = await Promise.all(waiting.slice(0, 20).map((o) => engine().snapshot(o.id)));
  const events = states
    .filter((s): s is OrderState => !!s)
    .flatMap((s) =>
      s.waits
        .filter((w) => w.kind === 'event')
        .map((w) => ({
          orderId: s.orderId!,
          title: s.order?.title ?? '',
          event: w.event!,
          nodeId: w.nodeId,
        })),
    );
  return { ...office, events };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const { instanceId } = await engine().runReplenish();
  return { started: instanceId };
}

export default function BackOffice() {
  const { products, customers, events } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  return (
    <>
      <PageHeader
        title="Back office"
        subtitle="The mock systems the commerce connectors talk to (D1), and a simulator for external events."
        actions={
          <Form method="post">
            <Button type="submit" variant="outline" disabled={nav.state !== 'idle'}>
              <RefreshCw /> Run stock review now
            </Button>
          </Form>
        }
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-6 pb-10 xl:grid-cols-2">
        <Section title="Event simulator" className="xl:col-span-2">
          {events.length ? (
            <div className="space-y-2">
              {events.map((e) => (
                <EventRow key={`${e.orderId}-${e.nodeId}`} e={e} />
              ))}
            </div>
          ) : (
            <Empty>No order is waiting for an external event.</Empty>
          )}
        </Section>
        <Section title="Inventory">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">SKU</th>
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 text-right font-medium">On hand</th>
                <th className="pb-2 text-right font-medium">Reserved</th>
                <th className="pb-2 text-right font-medium">Reorder at</th>
                <th className="pb-2 text-right font-medium">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((p) => {
                const low = p.stock - p.reserved <= p.reorderPoint;
                return (
                  <tr key={p.sku} className={low ? 'text-wait' : ''}>
                    <td className="py-1.5 font-mono">{p.sku}</td>
                    <td className="py-1.5">{p.name}</td>
                    <td className="py-1.5 text-right tabular">{p.stock}</td>
                    <td className="py-1.5 text-right tabular">{p.reserved}</td>
                    <td className="py-1.5 text-right tabular">
                      {p.reorderPoint}
                      {low ? ' ▲' : ''}
                    </td>
                    <td className="py-1.5 text-right tabular">{money(p.price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
        <Section title="Customers">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Customer</th>
                <th className="pb-2 font-medium">Tier</th>
                <th className="pb-2 font-medium">Terms</th>
                <th className="pb-2 text-right font-medium">Balance</th>
                <th className="pb-2 text-right font-medium">Limit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers.map((c) => (
                <tr key={c.id}>
                  <td className="py-1.5">
                    {c.name}
                    <div className="font-mono text-[10.5px] text-muted-foreground">{c.id}</div>
                  </td>
                  <td className="py-1.5">{c.tier}</td>
                  <td className="py-1.5">{c.terms}</td>
                  <td className="py-1.5 text-right tabular">{money(c.balance)}</td>
                  <td className="py-1.5 text-right tabular">
                    {c.creditLimit ? money(c.creditLimit) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  );
}

function EventRow({ e }: { e: { orderId: string; title: string; event: string } }) {
  const f = useFetcher<{ ok: boolean; delivered?: boolean; error?: string }>();
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1 text-sm">
        <Link to={`/orders/${e.orderId}`} className="font-mono text-xs hover:underline">
          {shortId(e.orderId)}
        </Link>{' '}
        <span className="text-muted-foreground">{e.title}</span> waits for{' '}
        <span className="font-mono text-primary">{e.event}</span>
      </div>
      {f.data?.delivered ? (
        <span className="text-ok text-xs">Delivered</span>
      ) : (
        <f.Form method="post" action={`/orders/${e.orderId}/action`}>
          <input type="hidden" name="intent" value="event" />
          <input type="hidden" name="event" value={e.event} />
          <Button size="sm" variant="outline" disabled={f.state !== 'idle'}>
            <Zap /> Send
          </Button>
        </f.Form>
      )}
    </div>
  );
}
