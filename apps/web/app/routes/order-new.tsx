import {
  BASE_CURRENCY,
  FULFILLMENT_METHOD_LABELS,
  FULFILLMENT_METHODS,
  type FulfillmentMethod,
  ORDER_CHANNEL_LABELS,
  ORDER_CHANNELS,
  ORDER_MODEL_LABELS,
  type OrderChannel,
  type OrderInput,
  type OrderModel,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { Textarea } from '@orderloop/ui/textarea';
import { useMemo, useRef, useState } from 'react';
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Field } from '~/components/inspector';
import { PageHeader } from '~/components/page';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded } from '~/lib/flows.server';
import { count, humanize, plural } from '~/lib/format';
import { addOne, describeIssues, parseLines, summarizeFlow } from '~/lib/new-order';
import { commerceData, currencies, demoAvailable, publishedFlowGraphs } from '~/lib/orders.server';
import { nodeRegistry } from '~/lib/plugins.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/order-new';

export const meta = () => [{ title: 'New order · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request, 'operator');
  await ensureSeeded();
  const [flows, office, demo, nodes] = await Promise.all([
    publishedFlowGraphs(),
    commerceData(),
    demoAvailable(),
    nodeRegistry(),
  ]);
  // "Edit first" on the scenarios page: the scenario's order without its simulated failure.
  const from = demo
    ? SCENARIOS.find((s) => s.id === new URL(request.url).searchParams.get('scenario'))
    : undefined;
  return {
    flows: flows.map(({ graph, ...f }) => ({ ...f, summary: summarizeFlow(graph, nodes) })),
    demo,
    from: from ? { label: from.label, flowId: from.flowId, input: from.input } : null,
    customers: office.customers,
    products: office.products.map((p) => ({
      sku: p.sku,
      name: p.name,
      available: p.stock - p.reserved,
    })),
    stores: office.stores.map(({ id, name }) => ({ id, name })),
    currencies: office.pricing.rates.map((r) => r.currency),
  };
}

type FieldName = 'flowId' | 'customerId' | 'contactEmail' | 'locationId' | 'currency' | 'lines';
type ActionResult = { error: string; field?: FieldName };

const fail = (error: string, field?: FieldName): ActionResult => ({ error, field });

const channelOf = (v: FormDataEntryValue | null): OrderChannel =>
  ORDER_CHANNELS.find((c) => c === v) ?? 'manual';

/** Only when the form asks for one; a flow without a routing step ships by default. */
const methodOf = (v: FormDataEntryValue | null) => FULFILLMENT_METHODS.find((m) => m === v);

/** Pickup and carry-out happen at a store, so they need one. */
const AT_STORE: FulfillmentMethod[] = ['pickup', 'carry_out'];

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const f = await request.formData();
  const str = (k: string) => String(f.get(k) ?? '').trim();

  const flowId = str('flowId');
  const flow = (await publishedFlowGraphs()).find((x) => x.id === flowId);
  if (!flow)
    return fail(
      'Pick a published flow. Flows must be published before orders can run on them.',
      'flowId',
    );

  const office = await commerceData();
  const parsed = parseLines(str('lines'), new Set(office.products.map((p) => p.sku)));
  if (parsed.issues.length)
    return fail(
      `Fix ${parsed.issues.length === 1 ? 'this line' : 'these lines'}: ${describeIssues(parsed.issues)}. Write “SKU x qty”, e.g. WID-100 x 5.`,
      'lines',
    );
  const documentText = str('documentText');
  if (!parsed.lines.length && !(documentText && summarizeFlow(flow.graph).readsDocument))
    return fail('Add at least one line.', 'lines');

  const buyer = str('buyer');
  const customerId = buyer === 'account' ? str('customerId') : '';
  if (customerId && !office.customers.some((c) => c.id === customerId))
    return fail('That customer no longer exists. Pick another.', 'customerId');
  const contactEmail = buyer === 'guest' ? str('contactEmail') : '';
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))
    return fail(`“${contactEmail}” is not an email address.`, 'contactEmail');

  const method = methodOf(f.get('fulfillment'));
  const locationId = method && AT_STORE.includes(method) ? str('locationId') : '';
  if (method && AT_STORE.includes(method) && !office.stores.some((s) => s.id === locationId))
    return fail(`${FULFILLMENT_METHOD_LABELS[method]} needs a store.`, 'locationId');

  const currency = str('currency') || BASE_CURRENCY;
  if (!(await currencies()).some((c) => c.currency === currency))
    return fail(`There is no exchange rate for ${currency}.`, 'currency');

  // Simulated failures are for demo scenarios only, which start from the scenarios page.
  const input: OrderInput = {
    model: flow.model as OrderModel,
    channel: channelOf(f.get('channel')),
    title: str('title') || undefined,
    customerId: customerId || undefined,
    contact: contactEmail
      ? { email: contactEmail, name: str('contactName') || undefined }
      : undefined,
    fulfillment: method ? { method, ...(locationId ? { locationId } : {}) } : undefined,
    currency,
    lines: parsed.lines,
    documentText: documentText || undefined,
    meta: {},
  };
  try {
    const { orderId } = await engine().startOrder({ flowId, input, startedBy: me.id });
    await audit(request, 'order.started', {
      actor: me,
      target: orderId,
      detail: { flowId, via: 'app' },
    });
    return redirect(`/orders/${orderId}`);
  } catch (err) {
    console.error('order start failed', err);
    return fail(
      'The order could not be started: the engine did not accept it. Your entries are kept; try again in a moment.',
    );
  }
}

export default function NewOrder() {
  const {
    flows,
    customers,
    products,
    stores,
    currencies: codes,
    demo,
    from,
  } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>() as ActionResult | undefined;
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const input = from?.input;

  const [flowId, setFlowId] = useState(from?.flowId ?? flows[0]?.id ?? '');
  const [buyer, setBuyer] = useState<'account' | 'guest'>(input?.contact ? 'guest' : 'account');
  const [method, setMethod] = useState<string>(input?.fulfillment?.method ?? '');
  const [lines, setLines] = useState(
    () => input?.lines.map((l) => `${l.sku} x ${l.qty}`).join('\n') ?? '',
  );
  const [checked, setChecked] = useState(false);
  const linesRef = useRef<HTMLTextAreaElement>(null);

  const flow = flows.find((f) => f.id === flowId);
  const summary = flow?.summary;
  const known = useMemo(() => new Set(products.map((p) => p.sku)), [products]);
  const available = useMemo(() => new Map(products.map((p) => [p.sku, p.available])), [products]);
  const preview = parseLines(lines, known);
  const short = preview.lines.filter((l) => l.qty > (available.get(l.sku) ?? 0));

  // The server's message for a field wins until the person edits; the live lines check after that.
  const serverError = (name: FieldName) => (data?.field === name ? data.error : undefined);
  const linesError =
    preview.issues.length > 0
      ? `Fix ${preview.issues.length === 1 ? 'this line' : 'these lines'}: ${describeIssues(preview.issues)}`
      : checked && !preview.lines.length && !summary?.readsDocument
        ? 'Add at least one line.'
        : serverError('lines');
  const atStore = AT_STORE.includes(method as FulfillmentMethod);

  return (
    <>
      <PageHeader
        title="New order"
        subtitle="Start an order by hand on a published flow. It runs like any other order from here on."
        actions={
          demo ? (
            <Link to="/orders/scenarios" className="text-link text-sm hover:underline">
              Run a demo scenario
            </Link>
          ) : null
        }
      />
      <div className="mx-auto grid max-w-page gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Form
          method="post"
          className="min-w-0 divide-y card overflow-hidden"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
          onSubmit={(e) => {
            setChecked(true);
            if (preview.issues.length || (!preview.lines.length && !summary?.readsDocument)) {
              e.preventDefault();
              linesRef.current?.focus();
            }
          }}
        >
          {from ? (
            <p className="px-5 py-3 text-muted-foreground text-sm">
              Filled in from the “{from.label}” scenario, without its simulated failure.{' '}
              <Link to="/orders/new" className="text-link hover:underline">
                Start blank
              </Link>
            </p>
          ) : null}

          <fieldset className="space-y-3 p-5">
            <legend className="sr-only">Flow</legend>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
              <Field label="Flow" hint="The steps this order runs">
                <NativeSelect
                  name="flowId"
                  value={flowId}
                  onChange={(e) => setFlowId(e.target.value)}
                  aria-invalid={!!serverError('flowId') || undefined}
                  aria-describedby="flow-summary"
                  wrapperClassName="w-full"
                  className="h-9 w-full"
                >
                  {flows.map((fl) => (
                    <NativeSelectOption key={fl.id} value={fl.id}>
                      {flowLabel(fl.name, fl.model as OrderModel)} · v{fl.version}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Came in by">
                <NativeSelect
                  name="channel"
                  defaultValue={input?.channel ?? 'manual'}
                  wrapperClassName="w-full"
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
            <FieldError id="flowId-error" message={serverError('flowId')} />
            {flow && summary ? (
              <FlowSummary id="flow-summary" flowId={flow.id} summary={summary} />
            ) : (
              <p id="flow-summary" className="text-muted-foreground text-sm">
                No flow is published yet.{' '}
                <Link to="/flows" className="text-link hover:underline">
                  Publish one
                </Link>{' '}
                to start orders on it.
              </p>
            )}
          </fieldset>

          <fieldset className="space-y-3 p-5">
            <legend className="section-title float-left mb-3 w-full">Buyer</legend>
            <Segmented
              name="buyer"
              aria-label="Buyer"
              value={buyer}
              onValueChange={(v) => setBuyer(v as typeof buyer)}
              className="clear-left grid w-full sm:w-80"
            >
              <SegmentedItem value="account">Customer account</SegmentedItem>
              <SegmentedItem value="guest">Guest</SegmentedItem>
            </Segmented>
            {buyer === 'account' ? (
              <div>
                <Field label="Customer">
                  <NativeSelect
                    name="customerId"
                    defaultValue={input?.customerId ?? ''}
                    aria-invalid={!!serverError('customerId') || undefined}
                    aria-describedby="customerId-error"
                    wrapperClassName="w-full"
                    className="h-9 w-full"
                  >
                    <NativeSelectOption value="">
                      {summary?.readsDocument ? 'Match from the document' : 'No customer'}
                    </NativeSelectOption>
                    {customers.map((c) => (
                      <NativeSelectOption key={c.id} value={c.id}>
                        {c.name} ({humanize(c.tier)})
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <FieldError id="customerId-error" message={serverError('customerId')} />
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Field label="Email" hint="Order emails go here">
                    <Input
                      name="contactEmail"
                      type="email"
                      required
                      autoComplete="off"
                      defaultValue={input?.contact?.email ?? ''}
                      aria-invalid={!!serverError('contactEmail') || undefined}
                      aria-describedby="contactEmail-error"
                    />
                  </Field>
                  <FieldError id="contactEmail-error" message={serverError('contactEmail')} />
                </div>
                <Field label="Name" hint="Optional">
                  <Input
                    name="contactName"
                    autoComplete="off"
                    defaultValue={input?.contact?.name ?? ''}
                  />
                </Field>
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3 p-5">
            <legend className="section-title float-left mb-3 w-full">Lines</legend>
            <div className="clear-left">
              <Field label="One per row" hint="SKU x qty, e.g. WID-100 x 5">
                <Textarea
                  ref={linesRef}
                  name="lines"
                  rows={4}
                  spellCheck={false}
                  autoCapitalize="characters"
                  className="font-mono text-base md:text-sm"
                  value={lines}
                  onChange={(e) => setLines(e.target.value)}
                  aria-invalid={!!linesError || undefined}
                  aria-describedby="lines-status"
                />
              </Field>
              <LinesStatus
                id="lines-status"
                error={linesError}
                lines={preview.lines}
                short={short.map((l) => l.sku)}
                available={available}
                readsDocument={!!summary?.readsDocument}
              />
            </div>
            <details className="group lg:hidden">
              <summary className="caption flex min-h-9 cursor-pointer list-none items-center hover:text-foreground">
                Add from the catalog
              </summary>
              <Catalog products={products} onAdd={(sku) => setLines((t) => addOne(t, sku))} />
            </details>
            {summary?.readsDocument ? (
              <Field
                label="Inbound document"
                hint="Paste the email or PO. With no lines above, the flow's AI extract step reads them from this."
              >
                <Textarea
                  name="documentText"
                  rows={6}
                  className="text-base md:text-sm"
                  defaultValue={input?.documentText ?? ''}
                />
              </Field>
            ) : null}
          </fieldset>

          {summary?.routesFulfillment ? (
            <fieldset className="space-y-3 p-5">
              <legend className="section-title float-left mb-3 w-full">Fulfillment</legend>
              <div className="clear-left grid gap-4 md:grid-cols-2">
                <Field label="Method" hint="Leave it to the flow to route">
                  <NativeSelect
                    name="fulfillment"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    wrapperClassName="w-full"
                    className="h-9 w-full"
                  >
                    <NativeSelectOption value="">Let the flow decide</NativeSelectOption>
                    {FULFILLMENT_METHODS.filter((m) => m !== 'digital').map((m) => (
                      <NativeSelectOption key={m} value={m}>
                        {FULFILLMENT_METHOD_LABELS[m]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                {atStore ? (
                  <div>
                    <Field label="Store">
                      <NativeSelect
                        name="locationId"
                        required
                        defaultValue={input?.fulfillment?.locationId ?? ''}
                        aria-invalid={!!serverError('locationId') || undefined}
                        aria-describedby="locationId-error"
                        wrapperClassName="w-full"
                        className="h-9 w-full"
                      >
                        <NativeSelectOption value="" disabled>
                          Choose a store
                        </NativeSelectOption>
                        {stores.map((l) => (
                          <NativeSelectOption key={l.id} value={l.id}>
                            {l.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                    <FieldError id="locationId-error" message={serverError('locationId')} />
                  </div>
                ) : null}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="space-y-3 p-5">
            <legend className="section-title float-left mb-3 w-full">Details</legend>
            <div className="clear-left grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
              <Field label="Title" hint="Optional">
                <Input
                  name="title"
                  defaultValue={input?.title ?? ''}
                  placeholder="e.g. Spring restock"
                />
              </Field>
              <div>
                <Field label="Currency" hint={`Converted from ${BASE_CURRENCY}`}>
                  <NativeSelect
                    name="currency"
                    defaultValue={input?.currency ?? BASE_CURRENCY}
                    aria-invalid={!!serverError('currency') || undefined}
                    aria-describedby="currency-error"
                    wrapperClassName="w-full"
                    className="h-9 w-full"
                  >
                    {codes.map((c) => (
                      <NativeSelectOption key={c} value={c}>
                        {c}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <FieldError id="currency-error" message={serverError('currency')} />
              </div>
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
            <Button type="submit" disabled={busy || !flow}>
              {busy ? 'Starting…' : 'Start order'}
            </Button>
            <span className="text-muted-foreground text-xs touch:hidden">
              <kbd className="font-sans">⌘</kbd> or <kbd className="font-sans">Ctrl</kbd> +{' '}
              <kbd className="font-sans">Enter</kbd>
            </span>
            {data?.error && !data.field ? (
              <p className="w-full text-bad text-sm" role="alert">
                {data.error}
              </p>
            ) : null}
          </div>
        </Form>

        <aside className="hidden min-w-0 lg:block">
          <div className="sticky top-20 card p-4">
            <h2 className="section-title">Catalog</h2>
            <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
              Click to add one; click again for more. Numbers are units available.
            </p>
            <Catalog products={products} onAdd={(sku) => setLines((t) => addOne(t, sku))} />
          </div>
        </aside>
      </div>
    </>
  );
}

/** The flow's name, and its order type when the name doesn't already say it. */
function flowLabel(name: string, model: OrderModel) {
  const type = ORDER_MODEL_LABELS[model];
  return name.toLowerCase().includes(type.toLowerCase()) ? name : `${name} (${type})`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="mt-1 text-bad text-xs" role="alert">
      {message}
    </p>
  ) : null;
}

/** What the chosen flow will ask of people, before anyone commits to it. */
function FlowSummary({
  id,
  flowId,
  summary,
}: {
  id: string;
  flowId: string;
  summary: ReturnType<typeof summarizeFlow>;
}) {
  const rows: { term: string; value: string; tone: string }[] = [
    summary.approvals.length
      ? { term: 'A person decides', value: summary.approvals.join(', '), tone: 'text-wait' }
      : {
          term: 'A person decides',
          value: 'Nowhere: it runs to its end on its own',
          tone: 'text-muted-foreground',
        },
  ];
  if (summary.waits.length)
    rows.push({ term: 'Waits for', value: summary.waits.join(', '), tone: 'text-foreground' });
  if (summary.rollbacks.length)
    rows.push({
      term: 'Undone if it fails',
      value: summary.rollbacks.join(', '),
      tone: 'text-undo',
    });
  return (
    <div id={id} className="rounded-md bg-muted/50 px-3 py-2.5 text-ui">
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
        {rows.map(({ term, value, tone }) => (
          <div key={term} className="contents">
            <dt className="caption pt-px">{term}</dt>
            <dd className={tone}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground text-xs">
        {plural(summary.steps, 'step')}.{' '}
        <Link to={`/flows/${flowId}`} className="text-link hover:underline">
          Open the flow
        </Link>
      </p>
    </div>
  );
}

function LinesStatus({
  id,
  error,
  lines,
  short,
  available,
  readsDocument,
}: {
  id: string;
  error?: string;
  lines: { sku: string; qty: number }[];
  short: string[];
  available: Map<string, number>;
  readsDocument: boolean;
}) {
  return (
    <div id={id} className="mt-1.5 space-y-0.5 text-xs" aria-live="polite">
      {lines.length ? (
        <p className="text-muted-foreground">
          {lines.map((l) => `${count(l.qty)} × ${l.sku}`).join(' · ')}
        </p>
      ) : !error ? (
        <p className="text-muted-foreground">
          {readsDocument
            ? 'No lines yet. Add them here, or leave this empty and paste the document below.'
            : 'No lines yet. Type them, or add from the catalog.'}
        </p>
      ) : null}
      {short.length ? (
        <p className="text-wait">
          More than in stock:{' '}
          {short.map((s) => `${s} (${count(available.get(s) ?? 0)} available)`).join(', ')}. The
          flow decides whether to backorder or fail.
        </p>
      ) : null}
      {error ? <p className="text-bad">{error}</p> : null}
    </div>
  );
}

function Catalog({
  products,
  onAdd,
}: {
  products: { sku: string; name: string; available: number }[];
  onAdd: (sku: string) => void;
}) {
  return (
    <ul className="-mx-2 max-h-[min(60vh,32rem)] overflow-y-auto text-sm">
      {products.map((p) => (
        <li key={p.sku}>
          <button
            type="button"
            onClick={() => onAdd(p.sku)}
            aria-label={`Add ${p.sku} ${p.name}, ${p.available > 0 ? `${count(p.available)} available` : 'none available'}`}
            className="flex min-h-8 w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          >
            <span className="min-w-0 truncate">
              <span className="font-mono text-xs">{p.sku}</span>{' '}
              <span className="text-muted-foreground">{p.name}</span>
            </span>
            <span
              className={p.available > 0 ? 'text-muted-foreground tabular' : 'text-wait text-xs'}
            >
              {p.available > 0 ? count(p.available) : 'None'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
