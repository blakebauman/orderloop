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
import { useEffect, useRef } from 'react';
import {
  Form,
  Link,
  useLoaderData,
  useRevalidator,
  useSearchParams,
  useSubmit,
} from 'react-router';
import { Ago, WaitingAt } from '~/components/ago';
import { Empty, PageHeader } from '~/components/page';
import { StatusBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { decodeCursor, encodeCursor } from '~/lib/cursor';
import { flowName } from '~/lib/flows.server';
import {
  count,
  money,
  orderRef,
  orderStatus,
  statusColor,
  statusLabel,
  waitingForLabel,
} from '~/lib/format';
import { customerNames, declinedOrderIds, listOrders } from '~/lib/orders.server';
import type { Route } from './+types/orders';

export const meta = () => [{ title: 'Orders · OrderLoop' }];

const PAGE = 200;

const SORTS = [
  { value: 'created', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'waiting', label: 'Waiting longest' },
  { value: 'total', label: 'Largest total' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

/** Bad endings, which name the step they stopped at and why. */
const ENDED_BADLY = ['failed', 'rolled_back', 'declined', 'cancelled'];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = new URL(request.url).searchParams;
  const sort: Sort = SORTS.find((s) => s.value === q.get('sort'))?.value ?? 'created';
  // Paging follows creation order, so only the default sort pages.
  const after = sort === 'created' ? decodeCursor(q.get('after')) : null;
  const orders = await listOrders(
    {
      model: q.get('model') || undefined,
      channel: q.get('channel') || undefined,
      status: q.get('status') || undefined,
      q: q.get('q') || undefined,
      attention: q.get('attention') === '1',
      flow: q.get('flow') || undefined,
      after: after ?? undefined,
      sort,
    },
    PAGE,
  );
  const [names, declinedSet] = await Promise.all([
    customerNames(orders.map((o) => o.customerId)),
    declinedOrderIds(orders.map((o) => o.id)),
  ]);
  const last = orders.at(-1);
  const flow = q.get('flow');
  return {
    flow: flow ? { id: flow, name: (await flowName(flow)) ?? flow } : null,
    orders,
    names,
    sort,
    declined: [...declinedSet],
    paged: !!after,
    older: sort === 'created' && orders.length === PAGE && last ? encodeCursor(last) : null,
  };
}

export default function Orders() {
  const { orders, names, sort, declined, paged, older, flow } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const submit = useSubmit();
  const search = useRef<HTMLInputElement>(null);
  const query = params.get('q') ?? '';
  const attention = params.get('attention') === '1';
  const filtered = !!(
    params.get('model') ||
    params.get('channel') ||
    params.get('status') ||
    query ||
    attention ||
    flow
  );

  const { revalidate } = useRevalidator();
  // The index is updated by each order's agent; refresh while anything is in flight and the tab
  // is in view.
  const live = orders.some((o) => ['queued', 'running', 'waiting'].includes(o.status));
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') revalidate();
    }, 4000);
    return () => window.clearInterval(t);
  }, [live, revalidate]);

  // "/" jumps to search from anywhere on the page that isn't already taking text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const n = orders.length;
  const capped = n === PAGE && !older;
  const subtitle = `${capped ? `First ${count(PAGE)}` : count(n)} ${n === 1 ? 'order' : 'orders'}${
    filtered ? ' match' : ''
  }${paged ? ', older page' : ''}${live ? ' · updating live' : ''}`;

  return (
    <>
      <PageHeader title="Orders" subtitle={<span aria-live="polite">{subtitle}</span>} />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <Form
          className="mb-4 grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap"
          onChange={(e) => {
            // Submit only what is set, so a shared link reads ?status=failed, not ?model=&….
            const data = new FormData(e.currentTarget);
            const next = new URLSearchParams();
            for (const [k, v] of data)
              if (v !== '' && !(k === 'sort' && v === 'created')) next.set(k, String(v));
            submit(next, { replace: true });
          }}
        >
          {/* Set from a flow's card; kept while the other filters change. */}
          {flow ? <input type="hidden" name="flow" value={flow.id} /> : null}
          <NativeSelect
            name="model"
            defaultValue={params.get('model') ?? ''}
            wrapperClassName="w-full sm:w-auto"
            className="h-8 w-full sm:w-40"
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
            wrapperClassName="w-full sm:w-auto"
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
            wrapperClassName="w-full sm:w-auto"
            className="h-8 w-full sm:w-36"
            aria-label="Status"
          >
            <NativeSelectOption value="">All statuses</NativeSelectOption>
            {ORDER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {statusLabel(s)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            name="sort"
            defaultValue={sort}
            wrapperClassName="w-full sm:w-auto"
            className="h-8 w-full sm:w-40"
            aria-label="Sort"
          >
            {SORTS.map((s) => (
              <NativeSelectOption key={s.value} value={s.value}>
                {s.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <div className="relative col-span-2 w-full sm:w-72">
            <Input
              ref={search}
              name="q"
              defaultValue={query}
              placeholder="Order #, title, customer, email"
              aria-label="Search orders by order number, title, customer, email or external id"
              aria-keyshortcuts="/"
              type="search"
              enterKeyHint="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-8 pr-8 touch:pr-3"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border px-1 font-sans text-[11px] text-muted-foreground touch:hidden"
            >
              /
            </span>
          </div>
          <label className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 text-[13px] text-muted-foreground has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:font-medium has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--ring)]">
            <input
              type="checkbox"
              name="attention"
              value="1"
              defaultChecked={attention}
              className="sr-only"
            />
            Needs attention
          </label>
          {filtered ? (
            <Button asChild variant="ghost" size="sm">
              <Link to={sort === 'created' ? '/orders' : `/orders?sort=${sort}`}>
                Clear filters
              </Link>
            </Button>
          ) : null}
        </Form>
        {flow ? (
          <p className="-mt-2 mb-3 text-muted-foreground text-xs">
            On the{' '}
            <Link to={`/flows/${flow.id}`} className="text-link hover:underline">
              {flow.name}
            </Link>{' '}
            flow, any version.{' '}
            <Link
              to={(() => {
                const next = new URLSearchParams(params);
                next.delete('flow');
                const s = next.toString();
                return s ? `?${s}` : '/orders';
              })()}
              className="text-link hover:underline"
            >
              All flows
            </Link>
          </p>
        ) : null}
        {attention ? (
          <p className="-mt-2 mb-3 text-muted-foreground text-xs">
            Failed or rolled back, or waiting on a person to decide.
          </p>
        ) : null}

        {n ? (
          <div className="rounded-md border bg-card">
            <table className="w-full text-sm">
              <thead className="hidden border-b text-left md:table-header-group">
                <tr>
                  <Th sorted={sort === 'created' || sort === 'oldest' ? sort : undefined}>Order</Th>
                  <Th>Status</Th>
                  <Th sorted={sort === 'waiting' ? 'waiting' : undefined}>Where</Th>
                  <Th>Customer</Th>
                  <Th right sorted={sort === 'total' ? 'total' : undefined}>
                    Total
                  </Th>
                  <Th right sorted={sort === 'updated' ? 'updated' : undefined}>
                    Updated
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((o) => {
                  const status = orderStatus(o.status, o.id, declined);
                  const modelLabel = ORDER_MODEL_LABELS[o.model as OrderModel] ?? o.model;
                  const channelLabel = ORDER_CHANNEL_LABELS[o.channel as OrderChannel] ?? o.channel;
                  const customer =
                    (o.customerId && names[o.customerId]) ||
                    (o.contactEmail ? `Guest · ${o.contactEmail}` : o.customerId) ||
                    'No customer';
                  const title = o.title || o.externalId;
                  return (
                    <tr
                      key={o.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2.5 hover:bg-muted/40 md:table-row md:px-0 md:py-0"
                    >
                      <td className="min-w-0 md:px-3 md:py-2">
                        <Link
                          to={`/orders/${o.id}`}
                          className={title ? 'font-medium hover:underline' : 'hover:underline'}
                        >
                          {title || <span className="text-muted-foreground">Untitled</span>}
                        </Link>{' '}
                        <span className="font-mono font-normal text-muted-foreground text-xs">
                          {orderRef(o.id)}
                        </span>
                        <div className="truncate text-muted-foreground text-xs">
                          {modelLabel}
                          {channelLabel !== modelLabel ? ` · ${channelLabel}` : ''} · started{' '}
                          <Ago ms={o.createdAt} />
                          {o.generation > 1 ? ` · run ${o.generation}` : ''}
                        </div>
                        <div className="truncate text-muted-foreground text-xs md:hidden">
                          {customer}
                        </div>
                      </td>
                      <td className="row-start-2 mt-1.5 md:mt-0 md:px-3 md:py-2">
                        <StatusBadge status={status} />
                      </td>
                      <td className="col-span-2 mt-1 min-w-0 text-xs md:max-w-72 md:px-3 md:py-2">
                        <Where order={o} status={status} />
                      </td>
                      <td className="hidden max-w-56 truncate text-muted-foreground md:table-cell md:px-3 md:py-2">
                        {customer}
                      </td>
                      <td className="col-start-2 row-start-1 text-right tabular md:px-3 md:py-2">
                        {money(o.total, o.currency)}
                      </td>
                      <td className="col-start-2 row-start-2 mt-1.5 text-right text-muted-foreground text-xs md:mt-0 md:px-3 md:py-2">
                        <Ago ms={o.updatedAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border bg-card">
            <Empty
              action={
                filtered ? null : (
                  <Link to="/orders/new" className="text-link text-sm hover:underline">
                    Start an order
                  </Link>
                )
              }
            >
              {query ? (
                <>
                  No orders match “{query}”
                  {params.get('model') || params.get('channel') || params.get('status') || attention
                    ? ' with these filters'
                    : ''}
                  . Search covers the order number, title, customer, email and external id.
                </>
              ) : attention ? (
                'Nothing needs attention: no order has failed, and none is waiting on a decision.'
              ) : filtered ? (
                'No orders match these filters.'
              ) : (
                'No orders yet.'
              )}
            </Empty>
          </div>
        )}

        {older || paged ? (
          <nav aria-label="Pages" className="mt-3 flex justify-between text-sm">
            {paged ? (
              <Link to={pageLink(params, null)} className="text-link hover:underline">
                Newest orders
              </Link>
            ) : (
              <span />
            )}
            {older ? (
              <Link to={pageLink(params, older)} className="text-link hover:underline">
                Older orders
              </Link>
            ) : null}
          </nav>
        ) : capped ? (
          <p className="mt-3 text-muted-foreground text-xs">
            Showing the first {count(PAGE)}. Narrow the filters, or sort newest first to page
            through all of them.
          </p>
        ) : null}
      </div>
    </>
  );
}

function pageLink(params: URLSearchParams, after: string | null) {
  const next = new URLSearchParams(params);
  if (after) next.set('after', after);
  else next.delete('after');
  const s = next.toString();
  return s ? `?${s}` : '/orders';
}

function Th({
  children,
  right,
  sorted,
}: {
  children: React.ReactNode;
  right?: boolean;
  /** The active sort, when this column is what the list is ordered by. */
  sorted?: Sort;
}) {
  return (
    <th
      scope="col"
      aria-sort={
        sorted
          ? sorted === 'oldest' || sorted === 'waiting'
            ? 'ascending'
            : 'descending'
          : undefined
      }
      className={`caption px-3 py-2 font-medium ${right ? 'text-right' : ''} ${sorted ? 'text-foreground' : ''}`}
    >
      {children}
    </th>
  );
}

type Row = Awaited<ReturnType<typeof loader>>['orders'][number];

/**
 * Where the order is: the step it waits at, for how long and on whom; or, for an order that ended
 * badly, the step it stopped at and why. Rows indexed before these were recorded show what they
 * have.
 */
function Where({ order: o, status }: { order: Row; status: string }) {
  if (o.waitingOn || o.waitingAt) {
    const who = waitingForLabel(o.waitingFor);
    // An event step is often named for its event ("Customer collects"); don't say it twice.
    const same = who.toLowerCase() === (o.waitingAt ?? '').toLowerCase();
    return (
      <>
        <div className="truncate text-foreground" title={o.waitingAt ?? undefined}>
          <span className="sr-only">Waiting at </span>
          <WaitingAt at={o.waitingAt} since={o.waitingSince} on={o.waitingOn} />
        </div>
        {who && !same ? (
          <div className="truncate text-muted-foreground" title={`On ${who}`}>
            on {who}
          </div>
        ) : null}
      </>
    );
  }
  if (ENDED_BADLY.includes(status) && (o.stoppedAt || o.reason)) {
    return (
      <>
        {o.stoppedAt ? (
          <div className="truncate" style={{ color: statusColor(status) }} title={o.stoppedAt}>
            <span className="sr-only">Stopped at </span>
            {o.stoppedAt}
          </div>
        ) : null}
        {o.reason ? (
          <div className="truncate text-muted-foreground" title={o.reason}>
            {o.reason}
          </div>
        ) : null}
      </>
    );
  }
  return <span className="hidden text-muted-foreground md:inline">—</span>;
}
