import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { Table, TableBody, TableEmpty, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Check, Mail, RefreshCw, Zap } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Form,
  Link,
  type ShouldRevalidateFunctionArgs,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from 'react-router';
import { Ago, WaitingAt } from '~/components/ago';
import { Empty, PageHeader, Section } from '~/components/page';
import { ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { type CommercePage, commercePage } from '~/lib/commerce.server';
import { type Paged, pageHref, pricesKey, shown, storeKey } from '~/lib/commerce-pages';
import { engine } from '~/lib/env.server';
import { eventAction, eventWaiting } from '~/lib/events';
import { count, humanize, money, orderRef, plural } from '~/lib/format';
import {
  customerNames,
  publishedFlows,
  recentInboundEmails,
  waitingOrders,
} from '~/lib/orders.server';
import { updateProductIndex } from '~/lib/product-index.server';
import { RECORD_KINDS, type RecordKind, type RecordRow, recordTone } from '~/lib/records';
import { recentRecords } from '~/lib/records.server';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import type { Route } from './+types/commerce';

export const meta = () => [{ title: 'Commerce · OrderLoop' }];

/** Waiting orders whose live state the page reads, newest first. */
const CHECKED = 20;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const q = params.get('q')?.trim() ?? '';
  const [office, waiting, emails, configured, flows, records] = await Promise.all([
    commercePage(params),
    waitingOrders(),
    recentInboundEmails(),
    // The engine owns INTAKE_MAILBOXES; ask it rather than assume the defaults.
    engine().intakeMailboxes(),
    publishedFlows(),
    recentRecords(q),
  ]);
  const host = new URL(request.url).hostname;
  const flowName = new Map(flows.map((f) => [f.id, f.name]));
  const mailboxes = Object.entries(configured).map(([local, flowId]) => ({
    address: `${local}@${host === 'localhost' ? 'orderloop.app' : host}`,
    flowId,
    flowName: flowName.get(flowId) ?? null,
  }));
  const states = (
    await Promise.all(waiting.slice(0, CHECKED).map((o) => engine().snapshot(o.id)))
  ).filter((s): s is OrderState => !!s);
  const names = await customerNames(states.map((s) => s.order?.customerId));
  const events = states.flatMap((s) =>
    s.waits
      .filter((w) => w.kind === 'event')
      .map((w) => {
        const o = s.order;
        return {
          orderId: s.orderId!,
          title: o?.title || (o ? ORDER_MODEL_LABELS[o.model as OrderModel] : ''),
          // Who the order is for and what it is worth, so a person can match it to the payment,
          // parcel or reply in front of them before recording it.
          customer:
            (o?.customerId ? names[o.customerId] : null) ||
            o?.contact?.name ||
            o?.contact?.email ||
            null,
          amount: w.amount ?? o?.total ?? 0,
          currency: o?.currency ?? BASE_CURRENCY,
          event: w.event!,
          nodeId: w.nodeId,
          since: w.since,
        };
      }),
  );
  return {
    ...office,
    events,
    partial: waiting.length > CHECKED,
    emails,
    mailboxes,
    records,
    q,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  // An admin's, refused for anyone else (`updateProductIndex`).
  if ((await request.formData()).get('intent') === 'product-index')
    return { productIndex: await updateProductIndex(request, me) };
  try {
    await engine().runReplenish();
    return { started: true as const };
  } catch (err) {
    console.error('stock review failed to start', err);
    return {
      started: false as const,
      error: 'Could not start the stock review. Nothing was ordered; try again in a moment.',
    };
  }
}

/**
 * Recording an outside event keeps its row, with its outcome, until the page is next loaded: a
 * refresh would drop the order from the list and the confirmation with it.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  // Nor does updating the product index change anything the page shows.
  if (formData?.get('intent') === 'event' || formData?.get('intent') === 'product-index')
    return false;
  return defaultShouldRevalidate;
}

type EventItem = Awaited<ReturnType<typeof loader>>['events'][number];
type Office = CommercePage;

const eventKey = (e: Pick<EventItem, 'orderId' | 'nodeId'>) => `${e.orderId}-${e.nodeId}`;

export default function Commerce() {
  const {
    inventory,
    customers,
    sellers,
    stores,
    pricing,
    events: allEvents,
    partial,
    emails,
    mailboxes,
    records,
    q,
  } = useLoaderData<typeof loader>();
  // One search narrows every section: the lists and records on the server, outside events here.
  const term = q.toLowerCase().replace(/^#/, '');
  const events = allEvents.filter(
    (e) => !term || [e.title, e.customer, e.orderId].some((x) => x?.toLowerCase().includes(term)),
  );
  const answered = useActionData<typeof action>();
  const review = answered && 'started' in answered ? answered : undefined;
  const nav = useNavigation();
  const canOperate = useCan('operator');
  const canAdmin = useCan('admin');
  const [recorded, setRecorded] = useState<ReadonlySet<string>>(new Set());
  const open = events.filter((e) => !recorded.has(eventKey(e))).length;
  // The stock review is the only form on this page that navigates.
  const reviewing = nav.state === 'submitting';
  return (
    <>
      <PageHeader
        title="Commerce"
        subtitle="Orders waiting on the outside world, what orders have done (payments, shipments, stock held, messages), and the stock, prices, customers and sellers the commerce steps work against."
        actions={
          canOperate ? (
            <Form method="post" className="flex flex-col items-end gap-1">
              <Button type="submit" variant="outline" disabled={reviewing}>
                <RefreshCw aria-hidden="true" />{' '}
                {reviewing ? 'Starting review…' : 'Run stock review now'}
              </Button>
              <span className="max-w-64 text-right text-muted-foreground text-xs">
                Starts a replenishment order for anything at or below its reorder point.
              </span>
            </Form>
          ) : undefined
        }
      />
      <div className="mx-auto max-w-page px-4 sm:px-6">
        {review ? (
          <p
            role={review.started ? 'status' : 'alert'}
            className={`mb-4 text-sm ${review.started ? '' : 'text-bad'}`}
          >
            {review.started ? (
              <>
                Stock review started. If any item is at or below its reorder point, a replenishment
                order appears in{' '}
                <Link to="/orders?model=replenishment" className="text-link hover:underline">
                  Orders
                </Link>
                .
              </>
            ) : (
              review.error
            )}
          </p>
        ) : null}
        <Form method="get" className="mb-3 flex flex-wrap items-center gap-2" role="search">
          <Input
            name="q"
            type="search"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            defaultValue={q}
            placeholder="Find an order, customer, SKU or seller"
            aria-label="Find an order, customer, SKU or seller"
            className="h-8 w-full sm:w-80"
          />
          <Button type="submit" size="sm" variant="outline">
            Find
          </Button>
          {q ? (
            <Link to="/commerce" className="text-link text-sm hover:underline">
              Clear
            </Link>
          ) : null}
          {q ? (
            <p className="w-full text-muted-foreground text-xs" role="status">
              Every section shows only what matches “{q}”.
            </p>
          ) : null}
        </Form>
      </div>
      <div className="mx-auto grid max-w-page gap-6 px-4 pb-10 sm:px-6 xl:grid-cols-2 xl:items-start">
        {/* On a phone the sections run long: the links stay under the top bar, on one scrolling line. */}
        <nav
          aria-label="On this page"
          className="sticky top-[var(--shell-h)] z-10 -mx-4 min-w-0 border-b bg-background px-4 text-sm sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 xl:col-span-2"
        >
          <ul className="flex gap-x-5 gap-y-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
            {[
              ['#outside-events', 'Outside events'],
              ['#records', 'Records'],
              ['#email-intake', 'Email intake'],
              ['#stock', 'Inventory'],
              ['#stores', 'Stores'],
              ['#pricing', 'Pricing'],
              ['#customers', 'Customers'],
              ['#sellers', 'Marketplace sellers'],
            ].map(([href, label]) => (
              <li key={href}>
                <a href={href} className="inline-block py-2.5 text-link hover:underline sm:py-1">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <Section
          id="outside-events"
          title="Outside events"
          className="xl:col-span-2"
          actions={
            open ? (
              <span className="font-medium text-wait text-xs tabular">{open} waiting</span>
            ) : null
          }
          flush
        >
          {events.length ? (
            <ul className="divide-y">
              {events.map((e) => (
                <EventRow
                  key={eventKey(e)}
                  e={e}
                  onRecorded={() =>
                    setRecorded((s) => (s.has(eventKey(e)) ? s : new Set(s).add(eventKey(e))))
                  }
                />
              ))}
            </ul>
          ) : (
            <Empty>
              {q
                ? `No order matching “${q}” is waiting for an outside event.`
                : 'No order is waiting for an outside event, such as a payment or a delivery.'}
            </Empty>
          )}
          {partial ? (
            <p className="border-t px-4 py-2.5 text-muted-foreground text-xs">
              These are from the {CHECKED} most recently updated waiting orders.{' '}
              <Link to="/orders?status=waiting" className="text-link hover:underline">
                See every waiting order
              </Link>
              .
            </p>
          ) : null}
        </Section>
        <Records records={records} q={q} />
        <Section id="email-intake" title="Email intake" className="xl:col-span-2" flush>
          <div className="flex items-start gap-3 border-b px-4 py-2.5 text-sm">
            <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <ul className="flex flex-wrap gap-x-5 gap-y-1">
                {mailboxes.map((m) => (
                  <li key={m.address} className="min-w-0">
                    <a
                      href={`mailto:${m.address}`}
                      className="break-all font-mono text-link hover:underline"
                    >
                      {m.address}
                    </a>{' '}
                    <span className="text-muted-foreground">
                      starts{' '}
                      <Link
                        to={`/flows/${m.flowId}`}
                        className="hover:text-foreground hover:underline"
                      >
                        {m.flowName ?? m.flowId}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="max-w-[75ch] text-muted-foreground text-xs">
                Mail is accepted from customers’ own addresses, their company domains and senders an
                administrator has allowed.
              </p>
            </div>
          </div>
          {emails.length ? (
            <ul className="divide-y">
              {emails.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm"
                >
                  <span
                    className={`w-20 shrink-0 font-medium text-xs ${
                      e.status === 'accepted'
                        ? 'text-ok'
                        : e.status === 'duplicate'
                          ? 'text-muted-foreground'
                          : 'text-bad'
                    }`}
                  >
                    {humanize(e.status)}
                  </span>
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="font-medium">{e.subject || '(no subject)'}</span>{' '}
                    <span className="break-words text-muted-foreground">
                      from {e.sender} to {e.mailbox}
                      {e.attachments ? ` · ${plural(e.attachments, 'attachment')}` : ''}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-baseline gap-3 text-xs">
                    {e.orderId ? (
                      <Link
                        to={`/orders/${e.orderId}`}
                        className="font-mono text-link hover:underline"
                      >
                        {orderRef(e.orderId)}
                      </Link>
                    ) : null}
                    <span className="text-muted-foreground">
                      <Ago ms={e.receivedAt} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>
              No email received yet. Send a purchase order to one of the addresses above.
            </Empty>
          )}
        </Section>
        <Section
          id="stock"
          title="Inventory"
          actions={<Total list={inventory} noun="item" />}
          flush
        >
          <p className="border-b px-4 py-2 text-muted-foreground text-xs">
            Warehouse stock. Stores keep their own, under Stores; a pickup or store sale draws from
            the store. Reserved stock is held by running orders.
          </p>
          {inventory.total || q ? (
            <Table stack="cards" scroll caption="Inventory">
              <TableHead>
                <Tr>
                  <Th>Item</Th>
                  <Th numeric>Available</Th>
                  <Th numeric>Reserved</Th>
                  <Th numeric>Reorder at</Th>
                  <Th numeric>Price</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {inventory.rows.map((p) => {
                  const available = p.stock - p.reserved;
                  // The stock review reorders anything at or below its reorder point.
                  const level = available <= 0 ? 'Out' : available <= p.reorderPoint ? 'Low' : null;
                  return (
                    <Tr key={p.sku} id={`sku-${p.sku}`} className="scroll-mt-20 target:bg-muted/60">
                      <Td>
                        {p.name}
                        <span className="ml-1.5 whitespace-nowrap font-mono text-muted-foreground text-xs">
                          {p.sku}
                        </span>
                      </Td>
                      {p.kind === 'digital' ? (
                        <Td colSpan={3} className="text-right text-muted-foreground">
                          Digital, no stock
                        </Td>
                      ) : (
                        <>
                          <Td
                            numeric
                            label="Available"
                            className={cn(
                              level === 'Out' && 'font-medium text-bad',
                              level === 'Low' && 'font-medium text-wait',
                            )}
                          >
                            {count(available)}
                            {level ? (
                              <span className="ml-1.5 text-xs">
                                {level === 'Out' ? 'out' : 'low'}
                                <span className="sr-only"> stock</span>
                              </span>
                            ) : null}
                            {level === 'Out' && p.inStores > 0 ? (
                              <span className="block font-normal text-muted-foreground text-xs">
                                {count(p.inStores)} in stores
                              </span>
                            ) : null}
                          </Td>
                          <Td numeric label="Reserved" className="text-muted-foreground">
                            <Held sku={p.sku} n={p.reserved} />
                          </Td>
                          <Td numeric label="Reorder at" className="text-muted-foreground">
                            {p.reorderPoint ? count(p.reorderPoint) : 'Not reordered'}
                          </Td>
                        </>
                      )}
                      <Td numeric label="Price">
                        {money(p.price)}
                      </Td>
                    </Tr>
                  );
                })}
                {q && !inventory.total ? (
                  <TableEmpty colSpan={5}>Nothing here matches “{q}”.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <Empty>No products yet.</Empty>
          )}
          <Pager list={inventory} listKey="inventory" hash="stock" label="Inventory" />
          {canAdmin ? <ProductIndexUpdate /> : null}
        </Section>
        <Section id="stores" title="Stores" flush>
          {stores.length ? (
            <Table stack="cards" scroll caption="Stores">
              <TableHead>
                <Tr>
                  <Th>Item</Th>
                  <Th numeric>Available</Th>
                  <Th numeric>Reserved</Th>
                  <Th numeric>On hand</Th>
                </Tr>
              </TableHead>
              {stores.map((l) => (
                <TableBody
                  key={l.id}
                  className="divide-y-0 border-b last:border-b-0 [&>tr:last-child>td]:pb-2.5"
                >
                  <Tr>
                    <Th
                      scope="rowgroup"
                      colSpan={4}
                      className="whitespace-normal pt-2 pb-0.5 normal-case tracking-normal"
                    >
                      <span className="font-medium text-foreground text-sm">{l.name}</span>
                      <span className="ml-2 font-normal text-muted-foreground text-xs">
                        {[l.pickup ? 'Pickup' : null, l.ships ? 'Ships orders' : null]
                          .filter(Boolean)
                          .join(' · ') || 'In-store sales only'}
                      </span>
                    </Th>
                  </Tr>
                  {l.stock.total ? (
                    l.stock.rows.map((s) => (
                      <Tr key={s.sku}>
                        <Td className="py-1 pl-8">
                          {s.name ?? s.sku}
                          <a
                            href={`#sku-${s.sku}`}
                            className="ml-1.5 whitespace-nowrap font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
                          >
                            {s.sku}
                          </a>
                        </Td>
                        <Td numeric label="Available" className="py-1">
                          {count(s.stock - s.reserved)}
                        </Td>
                        <Td numeric label="Reserved" className="py-1 text-muted-foreground">
                          <Held sku={s.sku} n={s.reserved} />
                        </Td>
                        <Td numeric label="On hand" className="py-1 text-muted-foreground">
                          {count(s.stock)}
                        </Td>
                      </Tr>
                    ))
                  ) : (
                    <Tr>
                      <Td colSpan={4} className="py-1 pl-8 text-muted-foreground text-xs">
                        {q ? 'Nothing here matches.' : 'No stock held here.'}
                      </Td>
                    </Tr>
                  )}
                  {l.stock.total > l.stock.size ? (
                    <Tr>
                      <Td colSpan={4} className="p-0">
                        <Pager
                          list={l.stock}
                          listKey={storeKey(l.id)}
                          hash="stores"
                          label={`${l.name} stock`}
                          inset
                        />
                      </Td>
                    </Tr>
                  ) : null}
                </TableBody>
              ))}
            </Table>
          ) : (
            <Empty>No stores yet.</Empty>
          )}
        </Section>
        <Pricing pricing={pricing} />
        <Section
          id="customers"
          title="Customers"
          actions={<Total list={customers} noun="customer" />}
          flush
        >
          {customers.total || q ? (
            <Table stack="cards" scroll caption="Customers">
              <TableHead>
                <Tr>
                  <Th>Customer</Th>
                  <Th>Terms</Th>
                  <Th numeric>Balance</Th>
                  <Th numeric>Credit limit</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {customers.rows.map((c) => {
                  const over = !!c.creditLimit && c.balance > c.creditLimit;
                  // Close enough that one more order could tip it over.
                  const near = !over && !!c.creditLimit && c.balance >= c.creditLimit * 0.9;
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          to={`/orders?q=${encodeURIComponent(c.name)}`}
                          className="hover:underline"
                          title={`Orders for ${c.name}`}
                        >
                          {c.name}
                        </Link>
                        <div className="text-muted-foreground text-xs">
                          {humanize(c.kind)}
                          {c.kind === 'business' ? ` · ${humanize(c.tier)}` : ''}
                        </div>
                      </Td>
                      <Td label="Terms">
                        {c.kind === 'business' ? humanize(c.terms) : 'Pays at checkout'}
                      </Td>
                      <Td
                        numeric
                        label="Balance"
                        className={cn(
                          over && 'font-medium text-bad',
                          near && 'font-medium text-wait',
                        )}
                      >
                        {money(c.balance)}
                        {over ? <span className="ml-1.5 text-xs">Over limit</span> : null}
                        {near ? <span className="ml-1.5 text-xs">Near limit</span> : null}
                      </Td>
                      <Td numeric label="Credit limit">
                        {c.creditLimit ? (
                          money(c.creditLimit)
                        ) : (
                          <span className="text-muted-foreground">No limit</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
                {q && !customers.total ? (
                  <TableEmpty colSpan={4}>Nothing here matches “{q}”.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <Empty>No customers yet.</Empty>
          )}
          <Pager list={customers} listKey="customers" hash="customers" label="Customers" />
        </Section>
        <Section
          id="sellers"
          title="Marketplace sellers"
          actions={<Total list={sellers} noun="seller" />}
          flush
        >
          {sellers.total || q ? (
            <Table stack="cards" scroll caption="Marketplace sellers">
              <TableHead>
                <Tr>
                  <Th>Seller</Th>
                  <Th>Accepts orders</Th>
                  <Th numeric>Commission</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {sellers.rows.map((s) => (
                  <Tr key={s.id}>
                    <Td>
                      <Link
                        to={`/commerce?q=${encodeURIComponent(s.name)}#records`}
                        className={cn('hover:underline', !s.active && 'text-muted-foreground')}
                        title={`Seller orders and payouts for ${s.name}`}
                      >
                        {s.name}
                      </Link>
                      {s.active ? null : <Off />}
                      <div className="break-all text-muted-foreground text-xs">{s.email}</div>
                    </Td>
                    <Td label="Accepts orders">
                      {s.autoAccept ? 'Automatically' : 'Asked per order'}
                    </Td>
                    <Td numeric label="Commission">
                      {Math.round(s.commissionPct * 1000) / 10}%
                    </Td>
                  </Tr>
                ))}
                {q && !sellers.total ? (
                  <TableEmpty colSpan={3}>Nothing here matches “{q}”.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <Empty>No marketplace sellers yet.</Empty>
          )}
          <Pager list={sellers} listKey="sellers" hash="sellers" label="Sellers" />
        </Section>
      </div>
    </>
  );
}

/**
 * An admin's run of the product index now, rather than at the next hourly update: after a large
 * import, say. It answers with what the run did; the page around it doesn't change.
 */
function ProductIndexUpdate() {
  const f = useFetcher<typeof action>();
  const running = f.state !== 'idle';
  const r = f.data && 'productIndex' in f.data ? f.data.productIndex : null;
  return (
    <f.Form
      method="post"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t bg-muted/50 px-4 py-3"
    >
      <input type="hidden" name="intent" value="product-index" />
      <Button type="submit" size="sm" variant="outline" disabled={running}>
        {running ? 'Updating index…' : 'Update product index'}
      </Button>
      <p
        aria-live="polite"
        className={cn(
          'min-w-0 flex-1 basis-56 text-xs',
          r && !r.ok ? 'text-bad' : 'text-muted-foreground',
        )}
      >
        {r
          ? r.ok
            ? r.message
            : r.error
          : 'Order extraction finds products by meaning once they are in the index, which updates hourly. Update it now after a large import.'}
      </p>
    </f.Form>
  );
}

/** Reserved stock, linked to the orders holding it (Records, Stock holds, for that SKU). */
function Held({ sku, n }: { sku: string; n: number }) {
  if (!n) return <>{count(0)}</>;
  return (
    <Link
      to={`/commerce?q=${encodeURIComponent(sku)}&records=holds#records`}
      className="text-link hover:underline"
      aria-label={`${count(n)} reserved: see the orders holding ${sku}`}
    >
      {count(n)}
    </Link>
  );
}

/**
 * What orders did to the outside world, by kind, newest first. Each row names its order and the
 * step that wrote it: every connector write is keyed by its step, so a retry finds the same row.
 */
function Records({ records, q }: { records: Record<RecordKind, RecordRow[]>; q: string }) {
  const [params] = useSearchParams();
  const asked = RECORD_KINDS.find((k) => k.id === params.get('records'))?.id;
  // With a search, open the first kind that has anything.
  const first = RECORD_KINDS.find((k) => records[k.id].length)?.id ?? 'money';
  const [kind, setKind] = useState<RecordKind>(asked ?? (q ? first : 'money'));
  useEffect(() => {
    setKind(asked ?? (q ? first : 'money'));
  }, [asked, q, first]);
  const rows = records[kind];
  const tablistId = useId();
  return (
    <Section id="records" title="Records" className="xl:col-span-2" flush>
      <div
        role="tablist"
        aria-label="Kinds of record"
        id={tablistId}
        className="flex flex-wrap gap-1 border-b px-3 py-2"
      >
        {RECORD_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            id={`${tablistId}-${k.id}`}
            aria-selected={kind === k.id}
            aria-controls={`${tablistId}-panel`}
            onClick={() => setKind(k.id)}
            className={cn(
              'min-h-8 rounded-md px-2.5 py-1 text-ui',
              kind === k.id
                ? 'bg-primary font-medium text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {k.label}{' '}
            <span className={cn('tabular', kind === k.id ? 'opacity-80' : 'opacity-70')}>
              {count(records[k.id].length)}
            </span>
          </button>
        ))}
      </div>
      <div id={`${tablistId}-panel`} role="tabpanel" aria-labelledby={`${tablistId}-${kind}`}>
        {rows.length ? (
          <Table stack="cards" scroll caption={RECORD_KINDS.find((k) => k.id === kind)?.label}>
            <TableHead>
              <Tr>
                <Th>Record</Th>
                <Th>Order</Th>
                <Th>Status</Th>
                <Th numeric>Amount</Th>
                <Th numeric>When</Th>
              </Tr>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="max-w-80">
                    <div className="break-words">{r.what}</div>
                    {r.detail || r.step ? (
                      <div className="break-words text-muted-foreground text-xs">
                        {r.detail}
                        {r.detail && r.step ? ' · ' : ''}
                        {r.step ? (
                          <span title="The step that wrote it; a retry finds this same record">
                            step <span className="font-mono">{r.step}</span>
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </Td>
                  <Td label="Order" className="max-w-72">
                    <Link to={`/orders/${r.orderId}`} className="hover:underline">
                      {r.orderTitle || 'Order'}
                    </Link>{' '}
                    <span className="font-mono text-muted-foreground text-xs">
                      {orderRef(r.orderId)}
                    </span>
                    {r.customer ? (
                      <div className="break-words text-muted-foreground text-xs">{r.customer}</div>
                    ) : null}
                  </Td>
                  <Td label="Status">
                    {r.status ? (
                      <ToneBadge tone={recordTone(r.status)} label={humanize(r.status)} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td numeric label="Amount">
                    {r.amount !== null ? money(r.amount, r.currency ?? undefined) : ''}
                  </Td>
                  <Td numeric label="When" className="text-muted-foreground text-xs">
                    <Ago ms={r.at} />
                  </Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            {q
              ? `No ${RECORD_KINDS.find((k) => k.id === kind)?.label.toLowerCase()} match “${q}”.`
              : 'Nothing yet. Orders write these as their steps run.'}
          </Empty>
        )}
      </div>
    </Section>
  );
}

/** The one mark for something switched off: a seller who takes no orders, an unused price source. */
function Off() {
  return <span className="ml-1.5 text-muted-foreground text-xs">Off</span>;
}

/** How long a recorded event can be taken back before it is sent, as with decisions. */
const UNDO_MS = 5000;

/**
 * One order waiting on the outside world. Recording the event opens a short undo window and sends
 * nothing until it closes, so "Undo" is real. Leaving the page sends it at once rather than drop it.
 */
function EventRow({ e, onRecorded }: { e: EventItem; onRecorded: () => void }) {
  const canOperate = useCan('operator');
  const f = useFetcher<{ ok: boolean; delivered?: boolean; error?: string }>();
  const [pendingAt, setPendingAt] = useState<number | null>(null);
  const now = useNow(pendingAt === null ? null : 250);
  const titleId = useId();
  const waitId = useId();
  const recordRef = useRef<HTMLButtonElement>(null);
  const action = `/orders/${e.orderId}/action`;
  const latest = useRef({ pending: false, e, submit: f.submit });
  latest.current.e = e;
  latest.current.submit = f.submit;
  latest.current.pending = pendingAt !== null;

  useEffect(() => {
    const body = () => {
      const b = new FormData();
      b.set('intent', 'event');
      b.set('event', latest.current.e.event);
      return b;
    };
    const flush = () => {
      if (!latest.current.pending) return;
      latest.current.pending = false;
      void fetch(action, { method: 'POST', body: body(), keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [action]);

  useEffect(() => {
    if (pendingAt === null) return;
    const t = window.setTimeout(() => {
      latest.current.pending = false;
      setPendingAt(null);
      latest.current.submit(
        { intent: 'event', event: latest.current.e.event },
        { method: 'post', action },
      );
    }, UNDO_MS);
    return () => window.clearTimeout(t);
  }, [pendingAt, action]);

  const delivered = f.data?.delivered === true;
  // The order stopped waiting before this reached it: someone or a connected system got there first.
  const missed = f.state === 'idle' && f.data?.ok === true && !delivered;
  useEffect(() => {
    if (delivered || missed) onRecorded();
  }, [delivered, missed, onRecorded]);

  const undo = () => {
    setPendingAt(null);
    // Undo unmounts itself; hand focus back to the control that started this.
    requestAnimationFrame(() => recordRef.current?.focus());
  };
  const label = eventAction(e.event);

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"
      onKeyDown={(k) => {
        if (pendingAt !== null && k.key === 'Escape') {
          k.preventDefault();
          undo();
        }
      }}
    >
      <div className="min-w-0 flex-1 basis-64 text-sm">
        <Link id={titleId} to={`/orders/${e.orderId}`} className="font-medium hover:underline">
          {e.title || 'Order'}{' '}
          <span className="font-mono font-normal text-muted-foreground text-xs">
            ref {e.orderId.slice(-6)}
          </span>
        </Link>
        <p id={waitId} className="text-muted-foreground">
          <WaitingAt at={`Waits for ${eventWaiting(e.event)}`} since={e.since} on={null} />
        </p>
        {e.customer || e.amount ? (
          <p className="text-muted-foreground text-xs tabular">
            {[e.customer, e.amount ? money(e.amount, e.currency) : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {f.data?.error ? (
          <p className="mt-1 text-bad text-sm" role="alert">
            {f.data.error}
          </p>
        ) : null}
        {missed ? (
          <p className="mt-1 text-sm" role="status">
            Nothing was recorded: the order had already stopped waiting for this. It may have
            arrived from a connected system. Open the order to see where it is now.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-sm">
        {!canOperate ? (
          <span className="text-muted-foreground text-xs">An operator records this.</span>
        ) : e.event === 'seller.responded' ? (
          // Each seller answers for their own part; the order page asks per seller.
          <Button asChild size="sm" variant="outline">
            <Link to={`/orders/${e.orderId}`} aria-describedby={`${titleId} ${waitId}`}>
              Answer per seller
            </Link>
          </Button>
        ) : delivered ? (
          <span role="status" className="inline-flex items-center gap-1.5 font-medium text-ok">
            <Check className="size-4" aria-hidden="true" /> Recorded
          </span>
        ) : missed ? null : pendingAt !== null ? (
          <div className="flex items-center gap-3">
            {/* Said once; the ticking number stays out of the live region. */}
            <span className="sr-only" role="status">
              {label} in {UNDO_MS / 1000} seconds. Press Undo or Escape to take it back.
            </span>
            <span aria-hidden="true">
              {label} in{' '}
              <span className="tabular" suppressHydrationWarning>
                {Math.max(1, Math.ceil((pendingAt + UNDO_MS - now) / 1000))}s
              </span>
            </span>
            <Button size="sm" variant="outline" onClick={undo} autoFocus>
              Undo
            </Button>
          </div>
        ) : f.state !== 'idle' ? (
          <span className="text-muted-foreground" aria-live="polite">
            Recording…
          </span>
        ) : (
          <Button
            ref={recordRef}
            size="sm"
            variant="outline"
            aria-describedby={`${titleId} ${waitId}`}
            onClick={() => setPendingAt(Date.now())}
          >
            <Zap /> {f.data?.error ? `Try again: ${label.toLowerCase()}` : label}
          </Button>
        )}
      </div>
    </li>
  );
}

/** The pricing chain, in the order `commerce.price` runs it, with each source's entries. */
function Pricing({ pricing }: Pick<Office, 'pricing'>) {
  const item = (sku: string | null, name: string | null) =>
    sku ? (name ? `${name} (${sku})` : sku) : null;
  const entries = (rows: Office['pricing']['sources'][number]['entries']['rows']) =>
    rows.map((r) => ({
      key: r.key,
      name: r.name,
      scope: [
        item(r.sku, r.productName),
        r.customerTier ? `${humanize(r.customerTier)} tier` : null,
        r.customerName,
        r.minQty ? `${count(r.minQty)}+` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      price: r.price != null ? money(r.price) : `${r.discountPct}% off list`,
    }));
  return (
    <Section id="pricing" title="Pricing" className="xl:col-span-2" flush>
      <ol className="divide-y">
        {pricing.sources.map((s, i) => {
          const rows = entries(s.entries.rows);
          return (
            <li key={s.id}>
              <div className="flex flex-wrap items-baseline gap-x-3 px-4 pt-2.5 pb-1">
                <span className="text-muted-foreground text-xs tabular">{i + 1}</span>
                <span className={`font-medium text-sm ${s.active ? '' : 'text-muted-foreground'}`}>
                  {s.label}
                </span>
                {s.active ? null : <Off />}
                <span className="text-muted-foreground text-xs">
                  priority {s.priority}
                  {s.active
                    ? s.stopProcessing
                      ? ' · a match here is the price; later sources are skipped'
                      : ' · a match here can be adjusted by later sources'
                    : ''}
                </span>
              </div>
              {rows.length ? (
                <Table
                  edge="flush"
                  caption={s.label}
                  className={cn('mb-2 table-fixed', !s.active && 'text-muted-foreground')}
                >
                  <TableHead className="sr-only">
                    <Tr>
                      <Th>Applies as</Th>
                      <Th>To</Th>
                      <Th numeric>Price</Th>
                    </Tr>
                  </TableHead>
                  <TableBody className="divide-y-0">
                    {rows.map((r) => (
                      <Tr key={r.key}>
                        <Td className="w-2/5 break-words py-0.5 pl-4 sm:w-1/2 sm:pl-10">
                          {r.name}
                        </Td>
                        <Td className="break-words py-0.5 text-muted-foreground text-xs">
                          {r.scope}
                        </Td>
                        <Td numeric className="w-24 py-0.5 pr-4">
                          {r.price}
                        </Td>
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="pb-2 pl-4 text-muted-foreground text-xs sm:pl-10">No entries.</p>
              )}
              <Pager
                list={s.entries}
                listKey={pricesKey(s.id)}
                hash="pricing"
                label={s.label}
                inset
              />
            </li>
          );
        })}
        <li className="flex items-baseline gap-3 px-4 py-2.5">
          <span className="text-muted-foreground text-xs tabular">
            {pricing.sources.length + 1}
          </span>
          <span className="font-medium text-sm">List price</span>
          <span className="text-muted-foreground text-xs">when nothing above matches</span>
        </li>
      </ol>
      <p className="border-t px-4 py-2.5 text-muted-foreground text-xs">
        <span className="block max-w-[75ch]">
          Prices are in {BASE_CURRENCY}. Orders in another currency convert at the rate below, fixed
          when the order is priced. Promotion codes are on the{' '}
          <Link to="/promotions" className="text-link hover:underline">
            Promotions
          </Link>{' '}
          page.
        </span>
        <span className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 tabular">
          {pricing.rates
            .filter((r) => r.currency !== BASE_CURRENCY)
            .map((r) => (
              <span key={r.currency}>
                1 {BASE_CURRENCY} = {r.rate} {r.currency}
              </span>
            ))}
        </span>
      </p>
    </Section>
  );
}

/** A section's count, in its header: "2,000 items". */
function Total({ list, noun }: { list: Paged<unknown>; noun: string }) {
  return list.total > list.size ? (
    <span className="text-muted-foreground text-xs tabular">
      {count(list.total)} {noun}s
    </span>
  ) : null;
}

/**
 * Where a list is ("26–50 of 2,000") and the pages either side, for a list longer than a page.
 * Links keep the search and every other list's page, and come back to the section.
 */
function Pager({
  list,
  listKey,
  hash,
  label,
  inset = false,
}: {
  list: Paged<unknown>;
  listKey: string;
  hash: string;
  label: string;
  inset?: boolean;
}) {
  const [params] = useSearchParams();
  if (list.total <= list.size) return null;
  const { first, last } = shown(list);
  const step = (page: number, text: string) =>
    page >= 1 && (page - 1) * list.size < list.total ? (
      <Link
        to={pageHref(params, listKey, page, hash)}
        className="hit-area text-link hover:underline"
        aria-label={`${text} page of ${label.toLowerCase()}`}
      >
        {text}
      </Link>
    ) : (
      <span className="text-muted-foreground" aria-hidden="true">
        {text}
      </span>
    );
  return (
    <nav
      aria-label={`${label} pages`}
      className={cn(
        'flex items-center gap-4 py-2 pr-4 text-xs',
        inset ? 'pl-8 sm:pl-10' : 'border-t pl-4',
      )}
    >
      <span className="text-muted-foreground tabular">
        {count(first)}–{count(last)} of {count(list.total)}
      </span>
      <span className="ml-auto flex gap-4">
        {step(list.page - 1, 'Previous')}
        {step(list.page + 1, 'Next')}
      </span>
    </nav>
  );
}
