import {
  BASE_CURRENCY,
  FULFILLMENT_METHOD_LABELS,
  FULFILLMENT_METHODS,
  ORDER_CHANNEL_LABELS,
  ORDER_CHANNELS,
  ORDER_MODEL_LABELS,
  type OrderChannel,
  type OrderLine,
  type OrderModel,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Textarea } from '@orderloop/ui/textarea';
import { useState } from 'react';
import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Field } from '~/components/inspector';
import { PageHeader } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded } from '~/lib/flows.server';
import { humanize } from '~/lib/format';
import { backOffice, currencies, publishedFlows } from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/order-new';

export const meta = () => [{ title: 'New order · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request, 'operator');
  await ensureSeeded();
  const [flows, office] = await Promise.all([publishedFlows(), backOffice()]);
  return {
    flows,
    customers: office.customers,
    products: office.products,
    stores: office.stores.map(({ id, name }) => ({ id, name })),
    currencies: office.pricing.rates.map((r) => r.currency),
  };
}

/** "WID-100 x 50" / "50 WID-100" / "WID-100, 50" per line. Lines without a SKU come back as errors. */
function parseLines(text: string): { lines: OrderLine[]; unreadable: string[] } {
  const lines: OrderLine[] = [];
  const unreadable: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const sku = /[A-Z]{2,4}-\d{2,4}/i.exec(l)?.[0]?.toUpperCase();
    const qty = Number(/(\d+(?:\.\d+)?)(?!.*\d)/.exec(l.replace(sku ?? '', ''))?.[1] ?? 1);
    if (sku) lines.push({ sku, qty });
    else unreadable.push(l);
  }
  return { lines, unreadable };
}

const channelOf = (v: FormDataEntryValue | null): OrderChannel =>
  ORDER_CHANNELS.find((c) => c === v) ?? 'manual';

/** Only when the form asks for one; a flow without a routing step ships by default. */
function fulfillmentOf(f: FormData) {
  const method = FULFILLMENT_METHODS.find((m) => m === f.get('fulfillment'));
  if (!method) return undefined;
  const locationId = String(f.get('locationId') ?? '') || undefined;
  return { method, ...(locationId ? { locationId } : {}) };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request, 'operator');
  const f = await request.formData();
  const flowId = String(f.get('flowId') ?? '');
  const flows = await publishedFlows();
  const flow = flows.find((x) => x.id === flowId);
  if (!flow)
    return {
      error: 'Pick a published flow. Flows must be published before orders can run on them.',
    };
  const currency = String(f.get('currency') ?? '') || BASE_CURRENCY;
  if (!(await currencies()).some((c) => c.currency === currency))
    return { error: `There is no exchange rate for ${currency}.` };
  const simulate = String(f.get('simulate') ?? '');
  const parsed = parseLines(String(f.get('lines') ?? ''));
  if (parsed.unreadable.length)
    return {
      error: `No SKU found on ${parsed.unreadable.length === 1 ? 'this line' : 'these lines'}: ${parsed.unreadable.map((l) => `“${l}”`).join(', ')}. Use “SKU x qty”, e.g. WID-100 x 5.`,
    };
  const contactEmail = String(f.get('contactEmail') ?? '').trim();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))
    return { error: `“${contactEmail}” is not an email address.` };
  try {
    const { orderId } = await engine().startOrder({
      flowId,
      input: {
        model: flow.model as OrderModel,
        channel: channelOf(f.get('channel')),
        title: String(f.get('title') ?? '') || undefined,
        customerId: String(f.get('customerId') ?? '') || undefined,
        contact: contactEmail
          ? { email: contactEmail, name: String(f.get('contactName') ?? '') || undefined }
          : undefined,
        fulfillment: fulfillmentOf(f),
        currency,
        lines: parsed.lines,
        documentText: String(f.get('documentText') ?? '') || undefined,
        meta: simulate ? { simulate } : {},
      },
    });
    return redirect(`/orders/${orderId}`);
  } catch (err) {
    return {
      error: `The order could not be started. ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export default function NewOrder() {
  const { flows, customers, products, stores, currencies: codes } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const [preset, setPreset] = useState(SCENARIOS[0]!);
  const [key, setKey] = useState(0);
  const [lines, setLines] = useState(() => linesText(SCENARIOS[0]!));
  const pick = (id: string) => {
    const s = SCENARIOS.find((x) => x.id === id);
    if (s) {
      setPreset(s);
      setLines(linesText(s));
      setKey((k) => k + 1);
    }
  };
  const addSku = (sku: string) =>
    setLines((t) => `${t.trim() ? `${t.trimEnd()}\n` : ''}${sku} x 1`);
  const preview = parseLines(lines);
  return (
    <>
      <PageHeader
        title="New order"
        subtitle="Start an order on a published flow. A preset fills the form with a demo scenario."
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Form method="post" key={key} className="min-w-0 space-y-4 rounded-md border bg-card p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Flow">
              <NativeSelect name="flowId" defaultValue={preset.flowId} className="h-9 w-full">
                {flows.map((fl) => (
                  <NativeSelectOption key={fl.id} value={fl.id}>
                    {fl.name === ORDER_MODEL_LABELS[fl.model as OrderModel]
                      ? fl.name
                      : `${fl.name} (${ORDER_MODEL_LABELS[fl.model as OrderModel]})`}{' '}
                    · v{fl.version}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Customer">
              <NativeSelect
                name="customerId"
                defaultValue={preset.input.customerId ?? ''}
                className="h-9 w-full"
              >
                <NativeSelectOption value="">
                  Guest, or find it from the document
                </NativeSelectOption>
                {customers.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name} ({humanize(c.tier)})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Channel" hint="Where the order came in">
              <NativeSelect
                name="channel"
                defaultValue={preset.input.channel ?? 'manual'}
                className="h-9 w-full"
              >
                {ORDER_CHANNELS.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {ORDER_CHANNEL_LABELS[c]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Guest email" hint="For a buyer without an account">
              <Input
                name="contactEmail"
                type="email"
                defaultValue={preset.input.contact?.email ?? ''}
                placeholder="sam@example.com"
              />
            </Field>
            <Field label="Guest name" hint="Optional">
              <Input name="contactName" defaultValue={preset.input.contact?.name ?? ''} />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Fulfillment" hint="For flows that route fulfillment">
              <NativeSelect
                name="fulfillment"
                defaultValue={preset.input.fulfillment?.method ?? ''}
                className="h-9 w-full"
              >
                <NativeSelectOption value="">Not set (ship)</NativeSelectOption>
                {FULFILLMENT_METHODS.filter((m) => m !== 'digital').map((m) => (
                  <NativeSelectOption key={m} value={m}>
                    {FULFILLMENT_METHOD_LABELS[m]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Store" hint="For pickup and carry-out">
              <NativeSelect
                name="locationId"
                defaultValue={preset.input.fulfillment?.locationId ?? ''}
                className="h-9 w-full"
              >
                <NativeSelectOption value="">None</NativeSelectOption>
                {stores.map((l) => (
                  <NativeSelectOption key={l.id} value={l.id}>
                    {l.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
            <Field label="Title" hint="Optional">
              <Input
                name="title"
                defaultValue={preset.input.title ?? ''}
                placeholder="e.g. Spring restock"
              />
            </Field>
            <Field label="Currency" hint={`Prices convert from ${BASE_CURRENCY}`}>
              <NativeSelect
                name="currency"
                defaultValue={preset.input.currency ?? BASE_CURRENCY}
                className="h-9 w-full"
              >
                {codes.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {c}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Lines" hint="One per line: SKU x qty">
            <Textarea
              name="lines"
              rows={4}
              className="font-mono text-sm"
              placeholder={'WID-100 x 120\nGSK-010 x 40'}
              value={lines}
              onChange={(e) => setLines(e.target.value)}
            />
          </Field>
          <p className="-mt-2 text-xs" aria-live="polite">
            {preview.unreadable.length ? (
              <span className="text-bad">
                No SKU on: {preview.unreadable.map((l) => `“${l}”`).join(', ')}
              </span>
            ) : preview.lines.length ? (
              <span className="text-muted-foreground">
                {preview.lines.map((l) => `${l.qty} × ${l.sku}`).join(' · ')}
              </span>
            ) : (
              <span className="text-muted-foreground">
                No lines: the AI extract step reads them from the document.
              </span>
            )}
          </p>
          <Field label="Inbound document" hint="Email or PO text for AI extraction">
            <Textarea
              name="documentText"
              rows={6}
              className="text-sm"
              defaultValue={preset.input.documentText ?? ''}
            />
          </Field>
          <details
            className="group rounded-md border px-3 py-2"
            open={!!preset.input.meta?.simulate}
          >
            <summary className="caption cursor-pointer hover:text-foreground">Demo options</summary>
            <div className="mt-2">
              <Field label="Simulate a failure">
                <NativeSelect
                  name="simulate"
                  defaultValue={String(preset.input.meta?.simulate ?? '')}
                  className="h-9 w-full"
                >
                  <NativeSelectOption value="">Nothing — happy path</NativeSelectOption>
                  <NativeSelectOption value="out_of_stock">Out of stock</NativeSelectOption>
                  <NativeSelectOption value="payment_decline">
                    Payment authorization declined
                  </NativeSelectOption>
                  <NativeSelectOption value="charge_fail">Renewal charge fails</NativeSelectOption>
                  <NativeSelectOption value="three_way_mismatch">
                    Supplier invoice mismatch
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
          </details>
          {data?.error ? (
            <p className="text-destructive text-sm" role="alert">
              {data.error}
            </p>
          ) : null}
          <Button type="submit" disabled={nav.state !== 'idle' || preview.unreadable.length > 0}>
            {nav.state !== 'idle' ? 'Starting…' : 'Start order'}
          </Button>
        </Form>
        <aside className="min-w-0 space-y-4">
          <div className="rounded-md border bg-card p-4">
            <h2 className="section-title mb-2">Demo presets</h2>
            <div className="space-y-0.5">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={preset.id === s.id}
                  onClick={() => pick(s.id)}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:font-medium"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-md border bg-card p-4">
            <h2 className="section-title">Catalog</h2>
            <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
              Click an item to add it to the lines. Numbers are units available.
            </p>
            <ul className="-mx-2 text-sm">
              {products.map((p) => (
                <li key={p.sku}>
                  <button
                    type="button"
                    onClick={() => addSku(p.sku)}
                    className="flex w-full justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/60"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-xs">{p.sku}</span>{' '}
                      <span className="text-muted-foreground">{p.name}</span>
                    </span>
                    <span className="text-muted-foreground tabular">{p.stock - p.reserved}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}

const linesText = (s: (typeof SCENARIOS)[number]) =>
  s.input.lines.map((l) => `${l.sku} x ${l.qty}`).join('\n');
