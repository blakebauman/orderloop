import {
  BASE_CURRENCY,
  ORDER_MODEL_LABELS,
  type OrderModel,
  type OrderState,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
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
} from 'react-router';
import { Ago, WaitingAt } from '~/components/ago';
import { Empty, PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { eventAction, eventWaiting } from '~/lib/events';
import { count, humanize, money, orderRef, plural } from '~/lib/format';
import {
  backOffice,
  customerNames,
  publishedFlows,
  recentInboundEmails,
  waitingOrders,
} from '~/lib/orders.server';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import type { Route } from './+types/back-office';

export const meta = () => [{ title: 'Back office · OrderLoop' }];

/** Waiting orders whose live state the page reads, newest first. */
const CHECKED = 20;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const [office, waiting, emails, configured, flows] = await Promise.all([
    backOffice(),
    waitingOrders(),
    recentInboundEmails(),
    // The engine owns INTAKE_MAILBOXES; ask it rather than assume the defaults.
    engine().intakeMailboxes(),
    publishedFlows(),
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
  return { ...office, events, partial: waiting.length > CHECKED, emails, mailboxes };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request, 'operator');
  try {
    await engine().runReplenish();
    return { started: true as const };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { started: false as const, error: `Could not start the stock review. ${detail}` };
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
  if (formData?.get('intent') === 'event') return false;
  return defaultShouldRevalidate;
}

type EventItem = Awaited<ReturnType<typeof loader>>['events'][number];
type Office = Awaited<ReturnType<typeof backOffice>>;

const eventKey = (e: Pick<EventItem, 'orderId' | 'nodeId'>) => `${e.orderId}-${e.nodeId}`;

export default function BackOffice() {
  const { products, customers, sellers, stores, pricing, events, partial, emails, mailboxes } =
    useLoaderData<typeof loader>();
  const review = useActionData<typeof action>();
  const nav = useNavigation();
  const canOperate = useCan('operator');
  const [recorded, setRecorded] = useState<ReadonlySet<string>>(new Set());
  const open = events.filter((e) => !recorded.has(eventKey(e))).length;
  const productName = new Map(products.map((p) => [p.sku, p.name]));
  // The stock review is the only form on this page that navigates.
  const reviewing = nav.state === 'submitting';
  return (
    <>
      <PageHeader
        title="Back office"
        subtitle="Orders waiting on the outside world, and the stock, prices, customers and sellers the commerce steps work against."
        actions={
          canOperate ? (
            <Form method="post">
              <Button type="submit" variant="outline" disabled={reviewing}>
                <RefreshCw /> {reviewing ? 'Starting review…' : 'Run stock review now'}
              </Button>
            </Form>
          ) : undefined
        }
      />
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
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
        <nav aria-label="On this page" className="mb-4 text-sm">
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
            {[
              ['#outside-events', 'Outside events'],
              ['#email-intake', 'Email intake'],
              ['#stock', 'Stock'],
              ['#pricing', 'Pricing'],
              ['#customers', 'Customers and sellers'],
            ].map(([href, label]) => (
              <li key={href}>
                <a href={href} className="inline-block py-1 text-link hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-10 sm:px-6 xl:grid-cols-2 xl:items-start">
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
              No order is waiting for an outside event, such as a payment or a delivery.
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
              <p className="text-muted-foreground text-xs">
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
                    className={`w-20 shrink-0 font-medium text-xs uppercase tracking-wide ${
                      e.status === 'accepted'
                        ? 'text-ok'
                        : e.status === 'duplicate'
                          ? 'text-muted-foreground'
                          : 'text-bad'
                    }`}
                  >
                    {e.status}
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
        <Section id="stock" title="Inventory" flush>
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
                  // The stock review reorders anything at or below its reorder point.
                  const level = available <= 0 ? 'Out' : available <= p.reorderPoint ? 'Low' : null;
                  return (
                    <tr key={p.sku}>
                      <td className="px-4 py-1.5">
                        {p.name}
                        <span className="ml-1.5 font-mono text-muted-foreground text-xs">
                          {p.sku}
                        </span>
                      </td>
                      {p.kind === 'digital' ? (
                        <td colSpan={3} className="px-2 py-1.5 text-right text-muted-foreground">
                          Digital, no stock
                        </td>
                      ) : (
                        <>
                          <td
                            className={`whitespace-nowrap px-2 py-1.5 text-right tabular ${
                              level === 'Out'
                                ? 'font-medium text-bad'
                                : level
                                  ? 'font-medium text-wait'
                                  : ''
                            }`}
                          >
                            {count(available)}
                            {level ? <span className="ml-1.5 text-xs">{level}</span> : null}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular">
                            {count(p.reserved)}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular">
                            {count(p.reorderPoint)}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-1.5 text-right tabular">{money(p.price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Stores" flush>
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
                  <th scope="col" className="caption px-4 py-2 text-right font-medium">
                    On hand
                  </th>
                </tr>
              </thead>
              {stores.map((l) => (
                <tbody key={l.id} className="border-b last:border-b-0 [&>tr:last-child>td]:pb-2.5">
                  <tr>
                    <th scope="rowgroup" colSpan={3} className="px-4 pt-2 pb-0.5 text-left">
                      <span className="font-medium">{l.name}</span>
                      <span className="ml-2 font-normal text-muted-foreground text-xs">
                        {[l.pickup ? 'Pickup' : null, l.ships ? 'Ships orders' : null]
                          .filter(Boolean)
                          .join(' · ') || 'In-store sales only'}
                      </span>
                    </th>
                  </tr>
                  {l.stock.length ? (
                    l.stock.map((s) => (
                      <tr key={s.sku}>
                        <td className="py-1 pr-2 pl-8">
                          {productName.get(s.sku) ?? s.sku}
                          <span className="ml-1.5 font-mono text-muted-foreground text-xs">
                            {s.sku}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right tabular">
                          {count(s.stock - s.reserved)}
                        </td>
                        <td className="px-4 py-1 text-right text-muted-foreground tabular">
                          {count(s.stock)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="py-1 pr-4 pl-8 text-muted-foreground text-xs">
                        No stock held here.
                      </td>
                    </tr>
                  )}
                </tbody>
              ))}
            </table>
          </div>
        </Section>
        <Pricing pricing={pricing} customers={customers} productName={productName} />
        <Section id="customers" title="Customers" flush>
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
                {customers.map((c) => {
                  const over = !!c.creditLimit && c.balance > c.creditLimit;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-1.5">
                        {c.name}
                        <div className="text-muted-foreground text-xs">
                          {humanize(c.kind)}
                          {c.kind === 'business' ? ` · ${humanize(c.tier)}` : ''}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        {c.kind === 'business' ? humanize(c.terms) : 'Pays at checkout'}
                      </td>
                      <td
                        className={`whitespace-nowrap px-2 py-1.5 text-right tabular ${over ? 'font-medium text-bad' : ''}`}
                      >
                        {money(c.balance)}
                        {over ? <span className="ml-1.5 text-xs">Over limit</span> : null}
                      </td>
                      <td className="px-4 py-1.5 text-right tabular">
                        {c.creditLimit ? (
                          money(c.creditLimit)
                        ) : (
                          <span className="text-muted-foreground">No limit</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Marketplace sellers" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left">
                <tr>
                  <th scope="col" className="caption px-4 py-2 font-medium">
                    Seller
                  </th>
                  <th scope="col" className="caption px-2 py-2 font-medium">
                    Accepts orders
                  </th>
                  <th scope="col" className="caption px-4 py-2 text-right font-medium">
                    Commission
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sellers.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-1.5">
                      <span className={s.active ? undefined : 'text-muted-foreground'}>
                        {s.name}
                      </span>
                      {s.active ? null : <Off />}
                      <div className="break-all text-muted-foreground text-xs">{s.email}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      {s.autoAccept ? 'Automatically' : 'Asked per order'}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular">
                      {Math.round(s.commissionPct * 1000) / 10}%
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
            {orderRef(e.orderId)}
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
          <div className="flex items-center gap-3" aria-live="polite">
            <span>
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
function Pricing({
  pricing,
  customers,
  productName,
}: Pick<Office, 'pricing' | 'customers'> & { productName: Map<string, string> }) {
  const customerName = (id: string | null) => customers.find((c) => c.id === id)?.name ?? id;
  const item = (sku: string | null) =>
    sku ? (productName.has(sku) ? `${productName.get(sku)} (${sku})` : sku) : null;
  const entries = (id: string) =>
    id === 'contract'
      ? pricing.contracts.map((c) => ({
          key: `${c.customerId}-${c.sku}`,
          name: `${customerName(c.customerId)}`,
          scope: item(c.sku) ?? '',
          price: money(c.price),
        }))
      : pricing.rules
          .filter((r) => r.sourceId === id)
          .map((r) => ({
            key: r.id,
            name: r.name,
            scope: [
              item(r.sku),
              r.customerTier ? `${humanize(r.customerTier)} tier` : null,
              r.customerId ? customerName(r.customerId) : null,
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
          const rows = entries(s.id);
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
                  {s.active ? (s.stopProcessing ? ' · stops the chain' : ' · keeps going') : ''}
                </span>
              </div>
              {rows.length ? (
                <table
                  className={`mb-2 w-full table-fixed text-sm ${s.active ? '' : 'text-muted-foreground'}`}
                >
                  <caption className="sr-only">{s.label} prices</caption>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Applies as</th>
                      <th scope="col">To</th>
                      <th scope="col">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td
                          className="w-2/5 break-words py-0.5 pr-2 pl-4 align-baseline sm:w-1/2 sm:truncate sm:pl-10"
                          title={r.name}
                        >
                          {r.name}
                        </td>
                        <td
                          className="break-words px-2 py-0.5 align-baseline text-muted-foreground text-xs sm:truncate"
                          title={r.scope}
                        >
                          {r.scope}
                        </td>
                        <td className="w-24 py-0.5 pr-4 pl-2 text-right align-baseline tabular">
                          {r.price}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="pb-2 pl-4 text-muted-foreground text-xs sm:pl-10">No entries.</p>
              )}
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
          Prices are in {BASE_CURRENCY}. Orders in another currency convert at{' '}
          {pricing.rates
            .filter((r) => r.currency !== BASE_CURRENCY)
            .map((r) => `${r.rate} ${r.currency}`)
            .join(', ')}{' '}
          per {BASE_CURRENCY}, fixed when the order is priced.
        </span>
      </p>
    </Section>
  );
}
