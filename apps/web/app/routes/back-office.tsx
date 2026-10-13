import { BASE_CURRENCY, DEFAULT_INTAKE_MAILBOXES, type OrderState } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Mail, RefreshCw, Zap } from 'lucide-react';
import { Form, Link, useFetcher, useLoaderData, useNavigation } from 'react-router';
import { Empty, PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ago, count, humanize, money, orderRef } from '~/lib/format';
import { backOffice, recentInboundEmails, waitingOrders } from '~/lib/orders.server';
import type { Route } from './+types/back-office';

export const meta = () => [{ title: 'Back office · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const [office, waiting, emails] = await Promise.all([
    backOffice(),
    waitingOrders(),
    recentInboundEmails(),
  ]);
  const host = new URL(request.url).hostname;
  const mailboxes = Object.entries(DEFAULT_INTAKE_MAILBOXES).map(([local, flowId]) => ({
    address: `${local}@${host === 'localhost' ? 'orderloop.io' : host}`,
    flowId,
  }));
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
  return { ...office, events, emails, mailboxes };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const { instanceId } = await engine().runReplenish();
  return { started: instanceId };
}

export default function BackOffice() {
  const { products, customers, pricing, events, emails, mailboxes } =
    useLoaderData<typeof loader>();
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
        <Section title="Email intake" className="xl:col-span-2" flush>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-2.5 text-sm">
            <Mail className="size-4 text-muted-foreground" aria-hidden="true" />
            {mailboxes.map((m) => (
              <span key={m.address}>
                <a href={`mailto:${m.address}`} className="font-mono text-link hover:underline">
                  {m.address}
                </a>{' '}
                <span className="text-muted-foreground">→ {m.flowId}</span>
              </span>
            ))}
            <span className="text-muted-foreground text-xs">
              Customers’ own addresses, their company domains and INTAKE_ALLOWLIST may send.
            </span>
          </div>
          {emails.length ? (
            <ul className="divide-y">
              {emails.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm"
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
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{e.subject || '(no subject)'}</span>{' '}
                    <span className="text-muted-foreground">
                      from {e.sender} to {e.mailbox}
                      {e.attachments
                        ? ` · ${count(e.attachments)} attachment${e.attachments === 1 ? '' : 's'}`
                        : ''}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </span>
                  </span>
                  {e.orderId ? (
                    <Link
                      to={`/orders/${e.orderId}`}
                      className="font-mono text-link text-xs hover:underline"
                    >
                      {orderRef(e.orderId)}
                    </Link>
                  ) : null}
                  <span className="w-20 text-right text-muted-foreground text-xs">
                    {ago(e.receivedAt)}
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
        <Pricing pricing={pricing} customers={customers} />
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

type Office = Awaited<ReturnType<typeof backOffice>>;

/** The pricing chain, in the order `commerce.price` runs it, with each source's entries. */
function Pricing({ pricing, customers }: Pick<Office, 'pricing' | 'customers'>) {
  const customerName = (id: string | null) => customers.find((c) => c.id === id)?.name ?? id;
  const entries = (id: string) =>
    id === 'contract'
      ? pricing.contracts.map((c) => ({
          key: `${c.customerId}-${c.sku}`,
          name: `${customerName(c.customerId)}`,
          scope: c.sku,
          price: money(c.price),
        }))
      : pricing.rules
          .filter((r) => r.sourceId === id)
          .map((r) => ({
            key: r.id,
            name: r.name,
            scope: [
              r.sku,
              r.customerTier ? `${humanize(r.customerTier)} tier` : null,
              r.customerId ? customerName(r.customerId) : null,
              r.minQty ? `${count(r.minQty)}+` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            price: r.price != null ? money(r.price) : `${r.discountPct}% off list`,
          }));
  return (
    <Section title="Pricing" className="xl:col-span-2" flush>
      <ol className="divide-y">
        {pricing.sources.map((s, i) => {
          const rows = entries(s.id);
          return (
            <li key={s.id} className={s.active ? undefined : 'opacity-60'}>
              <div className="flex items-baseline gap-3 px-4 pt-2.5 pb-1">
                <span className="text-muted-foreground text-xs tabular">{i + 1}</span>
                <span className="font-medium text-sm">{s.label}</span>
                <span className="text-muted-foreground text-xs">
                  priority {s.priority}
                  {s.active
                    ? s.stopProcessing
                      ? ' · stops the chain'
                      : ' · keeps going'
                    : ' · off'}
                </span>
              </div>
              {rows.length ? (
                <table className="mb-2 w-full table-fixed text-sm">
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="w-1/2 truncate py-0.5 pr-2 pl-10">{r.name}</td>
                        <td className="w-1/3 truncate px-2 py-0.5 text-muted-foreground text-xs">
                          {r.scope}
                        </td>
                        <td className="py-0.5 pr-4 pl-2 text-right tabular">{r.price}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="pb-2 pl-10 text-muted-foreground text-xs">No entries.</p>
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
        Prices are in {BASE_CURRENCY}. Orders in another currency convert at{' '}
        {pricing.rates
          .filter((r) => r.currency !== BASE_CURRENCY)
          .map((r) => `${r.rate} ${r.currency}`)
          .join(', ')}{' '}
        per {BASE_CURRENCY}, fixed when the order is priced.
      </p>
    </Section>
  );
}
