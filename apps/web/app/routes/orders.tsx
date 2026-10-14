import {
  ORDER_CHANNEL_LABELS,
  ORDER_CHANNELS,
  ORDER_MODEL_LABELS,
  ORDER_MODELS,
  ORDER_STATUSES,
  type OrderChannel,
  type OrderModel,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { ArrowDown } from 'lucide-react';
import { useEffect } from 'react';
import { Form, Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { Ago, WaitingAt } from '~/components/ago';
import { Empty, PageHeader } from '~/components/page';
import { StatusBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { money, orderRef, orderStatus, statusLabel } from '~/lib/format';
import { customerNames, declinedOrderIds, listOrders } from '~/lib/orders.server';
import type { Route } from './+types/orders';

export const meta = () => [{ title: 'Orders · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = new URL(request.url).searchParams;
  const sort = (['updated', 'total'] as const).find((s) => s === q.get('sort')) ?? 'created';
  const orders = await listOrders({
    model: q.get('model') || undefined,
    channel: q.get('channel') || undefined,
    status: q.get('status') || undefined,
    q: q.get('q') || undefined,
    sort,
  });
  const [names, declinedSet] = await Promise.all([
    customerNames(orders.map((o) => o.customerId)),
    declinedOrderIds(orders.map((o) => o.id)),
  ]);
  const declined = [...declinedSet];
  return { orders, names, sort, declined };
}

export default function Orders() {
  const { orders, names, sort, declined } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const filtered = !!(
    params.get('model') ||
    params.get('channel') ||
    params.get('status') ||
    params.get('q')
  );
  const sortLink = (key: 'updated' | 'total') => {
    const next = new URLSearchParams(params);
    if (sort === key) next.delete('sort');
    else next.set('sort', key);
    return `?${next}`;
  };
  const { revalidate } = useRevalidator();
  // The index is updated by each order's agent; refresh while anything is in flight.
  const live = orders.some((o) => ['queued', 'running', 'waiting'].includes(o.status));
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => revalidate(), 4000);
    return () => window.clearInterval(t);
  }, [live, revalidate]);

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle={`${orders.length === 200 ? 'Latest 200' : orders.length} ${orders.length === 1 ? 'order' : 'orders'}${filtered ? ' match' : ''}`}
      />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <Form
          className="mb-4 flex flex-wrap gap-2"
          onChange={(e) => e.currentTarget.requestSubmit()}
        >
          {params.get('sort') ? (
            <input type="hidden" name="sort" value={params.get('sort') ?? ''} />
          ) : null}
          <NativeSelect
            name="model"
            defaultValue={params.get('model') ?? ''}
            className="h-8 w-full sm:w-44"
            aria-label="Commerce model"
          >
            <NativeSelectOption value="">All models</NativeSelectOption>
            {ORDER_MODELS.map((m) => (
              <NativeSelectOption key={m} value={m}>
                {ORDER_MODEL_LABELS[m]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            name="channel"
            defaultValue={params.get('channel') ?? ''}
            className="h-8 w-full sm:w-40"
            aria-label="Channel"
          >
            <NativeSelectOption value="">All channels</NativeSelectOption>
            {ORDER_CHANNELS.map((c) => (
              <NativeSelectOption key={c} value={c}>
                {ORDER_CHANNEL_LABELS[c]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            name="status"
            defaultValue={params.get('status') ?? ''}
            className="h-8 w-full sm:w-40"
            aria-label="Status"
          >
            <NativeSelectOption value="">All statuses</NativeSelectOption>
            {ORDER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {statusLabel(s)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            name="q"
            defaultValue={params.get('q') ?? ''}
            placeholder="Search id, title, customer"
            aria-label="Search orders"
            type="search"
            className="h-8 w-full sm:w-64"
          />
          {filtered ? (
            <Button asChild variant="ghost" size="sm">
              <Link to="/orders">Clear filters</Link>
            </Button>
          ) : null}
        </Form>
        {orders.length ? (
          <div className="rounded-md border bg-card">
            <table className="w-full text-sm">
              <thead className="hidden border-b text-left md:table-header-group">
                <tr>
                  <th scope="col" className="caption px-3 py-2 font-medium">
                    Order
                  </th>
                  <th scope="col" className="caption px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="caption px-3 py-2 font-medium">
                    Waiting at
                  </th>
                  <th scope="col" className="caption px-3 py-2 font-medium">
                    Customer
                  </th>
                  <SortHeader label="Total" active={sort === 'total'} to={sortLink('total')} />
                  <SortHeader
                    label="Updated"
                    active={sort === 'updated'}
                    to={sortLink('updated')}
                  />
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2.5 hover:bg-muted/40 md:table-row md:px-0 md:py-0"
                  >
                    <td className="min-w-0 md:px-3 md:py-2">
                      <Link to={`/orders/${o.id}`} className="font-medium hover:underline">
                        {o.title || ORDER_MODEL_LABELS[o.model as OrderModel]}
                      </Link>{' '}
                      <span className="font-mono font-normal text-muted-foreground text-xs">
                        {orderRef(o.id)}
                      </span>
                      <div className="truncate text-muted-foreground text-xs">
                        {ORDER_MODEL_LABELS[o.model as OrderModel]} ·{' '}
                        {ORDER_CHANNEL_LABELS[o.channel as OrderChannel] ?? o.channel} · started{' '}
                        <Ago ms={o.createdAt} />
                        {o.generation > 1 ? ` · run ${o.generation}` : ''}
                        <span className="md:hidden">
                          {' '}
                          · {(o.customerId && names[o.customerId]) || o.customerId || 'No customer'}
                        </span>
                      </div>
                    </td>
                    <td className="row-start-2 mt-1.5 md:mt-0 md:px-3 md:py-2">
                      <StatusBadge status={orderStatus(o.status, o.id, declined)} />
                    </td>
                    <td className="col-span-2 mt-1 truncate text-muted-foreground text-xs md:max-w-64 md:px-3 md:py-2">
                      {o.waitingOn ? (
                        <>
                          <span className="md:hidden">
                            {o.waitingAt ? 'Waiting at ' : 'Waiting on '}
                          </span>
                          <WaitingAt at={o.waitingAt} since={o.waitingSince} on={o.waitingOn} />
                        </>
                      ) : (
                        <span className="hidden md:inline">—</span>
                      )}
                    </td>
                    <td className="hidden text-muted-foreground md:table-cell md:px-3 md:py-2">
                      {(o.customerId && names[o.customerId]) || o.customerId || '—'}
                    </td>
                    <td className="col-start-2 row-start-1 text-right tabular md:px-3 md:py-2">
                      {money(o.total, o.currency)}
                    </td>
                    <td className="col-start-2 row-start-2 mt-1.5 text-right text-muted-foreground text-xs md:mt-0 md:px-3 md:py-2">
                      <Ago ms={o.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border bg-card">
            <Empty
              action={
                filtered ? (
                  <Link to="/orders" className="text-link text-sm hover:underline">
                    Clear filters
                  </Link>
                ) : (
                  <Link to="/orders/new" className="text-link text-sm hover:underline">
                    Start an order
                  </Link>
                )
              }
            >
              {filtered ? 'No orders match these filters.' : 'No orders yet.'}
            </Empty>
          </div>
        )}
      </div>
    </>
  );
}

function SortHeader({ label, active, to }: { label: string; active: boolean; to: string }) {
  return (
    <th
      scope="col"
      aria-sort={active ? 'descending' : 'none'}
      className="caption px-3 py-2 text-right font-medium"
    >
      <Link
        to={to}
        className={active ? 'text-foreground' : 'hover:text-foreground'}
        title={active ? 'Back to newest first' : `Sort by ${label.toLowerCase()}, highest first`}
      >
        {label}
        {active ? <ArrowDown className="ml-0.5 inline size-3" aria-hidden="true" /> : null}
      </Link>
    </th>
  );
}
