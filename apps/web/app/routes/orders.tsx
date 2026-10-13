import { ORDER_STATUSES, ORDER_TYPE_LABELS, ORDER_TYPES, type OrderType } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { useEffect } from 'react';
import { Form, Link, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { Empty, PageHeader } from '~/components/page';
import { StatusBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { ago, money, shortId, statusLabel } from '~/lib/format';
import { listOrders } from '~/lib/orders.server';
import type { Route } from './+types/orders';

export const meta = () => [{ title: 'Orders · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = new URL(request.url).searchParams;
  const orders = await listOrders({
    type: q.get('type') || undefined,
    status: q.get('status') || undefined,
    q: q.get('q') || undefined,
  });
  return { orders };
}

export default function Orders() {
  const { orders } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
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
        subtitle={`${orders.length} shown`}
        actions={
          <Button asChild>
            <Link to="/orders/new">New order</Link>
          </Button>
        }
      />
      <div className="mx-auto max-w-[1400px] px-6 pb-10">
        <Form
          className="mb-4 flex flex-wrap gap-2"
          onChange={(e) => e.currentTarget.requestSubmit()}
        >
          <NativeSelect name="type" defaultValue={params.get('type') ?? ''} className="h-8 w-44">
            <NativeSelectOption value="">All types</NativeSelectOption>
            {ORDER_TYPES.map((t) => (
              <NativeSelectOption key={t} value={t}>
                {ORDER_TYPE_LABELS[t]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            name="status"
            defaultValue={params.get('status') ?? ''}
            className="h-8 w-40"
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
            className="h-8 w-64"
          />
        </Form>
        {orders.length ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-[11px] text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 font-medium">Order</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Waiting on</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link to={`/orders/${o.id}`} className="font-medium hover:underline">
                        {o.title || shortId(o.id)}
                      </Link>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {o.id}
                        {o.generation > 1 ? ` · run ${o.generation}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {ORDER_TYPE_LABELS[o.type as OrderType]}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="max-w-64 truncate px-3 py-2 text-muted-foreground text-xs">
                      {o.waitingOn ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground text-xs">
                      {o.customerId ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular">{money(o.total, o.currency)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground text-xs">
                      {ago(o.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No orders match.</Empty>
        )}
      </div>
    </>
  );
}
