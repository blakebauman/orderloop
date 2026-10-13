import type { OrderState } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { RefreshCw, Zap } from 'lucide-react';
import { Form, Link, useFetcher, useLoaderData, useNavigation } from 'react-router';
import { Empty, PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { count, humanize, money, orderRef } from '~/lib/format';
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
        subtitle="The demo inventory, customers and outside events the commerce steps work against."
        actions={
          <Form method="post">
            <Button type="submit" variant="outline" disabled={nav.state !== 'idle'}>
              <RefreshCw /> {nav.state !== 'idle' ? 'Starting review…' : 'Run stock review now'}
            </Button>
          </Form>
        }
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-10 sm:px-6 xl:grid-cols-2">
        <Section title="Outside events" className="xl:col-span-2" flush>
          {events.length ? (
            <ul className="divide-y">
              {events.map((e) => (
                <EventRow key={`${e.orderId}-${e.nodeId}`} e={e} />
              ))}
            </ul>
          ) : (
            <Empty>
              No order is waiting for an outside event, such as a payment or a delivery.
            </Empty>
          )}
        </Section>
        <Section title="Inventory" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left">
                <tr>
                  <th scope="col" className="caption px-4 py-2 font-medium">
                    Item
                  </th>
                  <th scope="col" className="caption px-2 py-2 text-right font-medium">
                    Available
                  </th>
                  <th scope="col" className="caption px-2 py-2 text-right font-medium">
                    Reserved
                  </th>
                  <th scope="col" className="caption px-2 py-2 text-right font-medium">
                    Reorder at
                  </th>
                  <th scope="col" className="caption px-4 py-2 text-right font-medium">
                    Price
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {products.map((p) => {
                  const available = p.stock - p.reserved;
                  const low = available <= p.reorderPoint;
                  return (
                    <tr key={p.sku}>
                      <td className="px-4 py-1.5">
                        {p.name}
                        <span className="ml-1.5 font-mono text-muted-foreground text-xs">
                          {p.sku}
                        </span>
                      </td>
                      <td
                        className={`px-2 py-1.5 text-right tabular ${low ? 'font-medium text-wait' : ''}`}
                      >
                        {count(available)}
                        {low ? <span className="ml-1.5 text-xs">Low</span> : null}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular">
                        {count(p.reserved)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular">
                        {count(p.reorderPoint)}
                      </td>
                      <td className="px-4 py-1.5 text-right tabular">{money(p.price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Customers" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left">
                <tr>
                  <th scope="col" className="caption px-4 py-2 font-medium">
                    Customer
                  </th>
                  <th scope="col" className="caption px-2 py-2 font-medium">
                    Terms
                  </th>
                  <th scope="col" className="caption px-2 py-2 text-right font-medium">
                    Balance
                  </th>
                  <th scope="col" className="caption px-4 py-2 text-right font-medium">
                    Credit limit
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-1.5">
                      {c.name}
                      <div className="text-muted-foreground text-xs">{humanize(c.tier)}</div>
                    </td>
                    <td className="px-2 py-1.5">{humanize(c.terms)}</td>
                    <td
                      className={`px-2 py-1.5 text-right tabular ${c.creditLimit && c.balance > c.creditLimit ? 'font-medium text-bad' : ''}`}
                    >
                      {money(c.balance)}
                      {c.creditLimit && c.balance > c.creditLimit ? (
                        <span className="ml-1.5 text-xs">Over limit</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular">
                      {c.creditLimit ? money(c.creditLimit) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </>
  );
}

function EventRow({ e }: { e: { orderId: string; title: string; event: string } }) {
  const f = useFetcher<{ ok: boolean; delivered?: boolean; error?: string }>();
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1 text-sm">
        <Link to={`/orders/${e.orderId}`} className="font-medium hover:underline">
          {e.title || 'Order'}
        </Link>{' '}
        <span className="font-mono font-normal text-muted-foreground text-xs">
          {orderRef(e.orderId)}
        </span>{' '}
        <span className="text-muted-foreground">waits for</span>{' '}
        <span className="font-mono">{e.event}</span>
        {f.data?.error ? (
          <p className="mt-1 text-bad text-sm" role="alert">
            {f.data.error}
          </p>
        ) : null}
      </div>
      {f.data?.delivered ? (
        <span className="text-ok text-sm">Delivered</span>
      ) : (
        <f.Form method="post" action={`/orders/${e.orderId}/action`}>
          <input type="hidden" name="intent" value="event" />
          <input type="hidden" name="event" value={e.event} />
          <Button size="sm" variant="outline" disabled={f.state !== 'idle'}>
            <Zap /> Send {e.event}
          </Button>
        </f.Form>
      )}
    </li>
  );
}
