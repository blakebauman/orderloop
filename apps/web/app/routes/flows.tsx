import {
  autoLayout,
  BUY_SIDE_MODELS,
  DEFAULT_TEMPLATE,
  type Flow,
  ORDER_MODEL_LABELS,
  ORDER_MODELS,
  type OrderChannel,
  type OrderModel,
  TEMPLATES,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@orderloop/ui/native-select';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { Textarea } from '@orderloop/ui/textarea';
import { Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from 'react-router';
import { Ago } from '~/components/ago';
import { Field } from '~/components/inspector';
import { PageHeader } from '~/components/page';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { getFlow, listFlows, orderRoutes, saveFlow, setArchived } from '~/lib/flows.server';
import { count } from '~/lib/format';
import { runningByFlow } from '~/lib/orders.server';
import { receives } from '~/lib/routing';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/flows';

export const meta = () => [{ title: 'Flows · OrderLoop' }];

const SELLING = ORDER_MODELS.filter((m) => !BUY_SIDE_MODELS.includes(m));

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const archived = new URL(request.url).searchParams.get('archived') === '1';
  const [list, running, mailboxes, archivedCount] = await Promise.all([
    listFlows({ archived }),
    runningByFlow(),
    // The engine owns INTAKE_MAILBOXES; ask it rather than assume the defaults.
    engine()
      .intakeMailboxes()
      .catch(() => ({}) as Record<string, string>),
    archived ? Promise.resolve(0) : listFlows({ archived: true }).then((l) => l.length),
  ]);
  const routes = orderRoutes();
  return {
    archived,
    archivedCount,
    flows: list.map((f) => ({
      ...f,
      receives: receives(f, routes, mailboxes),
      running: running[f.id] ?? {},
    })),
    templates: Object.fromEntries(
      ORDER_MODELS.map((m) => {
        const t = TEMPLATES[DEFAULT_TEMPLATE[m]]();
        return [m, { name: t.name, steps: t.nodes.length }];
      }),
    ) as Record<OrderModel, { name: string; steps: number }>,
  };
}

const slug = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'flow'
  }-${Date.now().toString(36).slice(-4)}`;

/** A name from what someone asked the assistant for: its first few words. */
const nameFrom = (prompt: string) => {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6);
  const s = words.join(' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
};

type ActionResult = { error: string; field?: 'name' | 'prompt' | 'model'; flowId?: string };

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const f = await request.formData();
  const intent = String(f.get('intent') ?? '');

  // Archive and restore: only drafts that were never published, so nothing can be running on them.
  if (intent === 'archive' || intent === 'restore') {
    const flowId = String(f.get('flowId') ?? '');
    if (!(await setArchived(flowId, intent === 'archive')))
      return {
        error: 'Only a draft that was never published can be archived.',
        flowId,
      } satisfies ActionResult;
    await audit(request, intent === 'archive' ? 'flow.archived' : 'flow.restored', {
      actor: me,
      target: flowId,
      detail: { via: 'app' },
    });
    return null;
  }

  // Duplicate: the flow's current draft as a new, unpublished flow.
  if (intent === 'duplicate') {
    const src = await getFlow(String(f.get('flowId') ?? ''));
    if (!src) return { error: 'That flow no longer exists.' } satisfies ActionResult;
    const name = `${src.flow.name} (copy)`;
    const id = slug(name);
    await saveFlow({ ...src.flow, id, name });
    await audit(request, 'flow.saved', {
      actor: me,
      target: id,
      detail: { name, from: src.flow.id, via: 'app' },
    });
    return redirect(`/flows/${id}`);
  }

  const model = ORDER_MODELS.find((m) => m === f.get('model'));
  if (!model) return { error: 'Choose a commerce model.', field: 'model' } satisfies ActionResult;
  const prompt = String(f.get('prompt') ?? '').trim();
  const generate = intent === 'generate';
  const name = String(f.get('name') ?? '').trim() || (generate ? nameFrom(prompt) : '');
  if (generate && !prompt)
    return {
      error: 'Describe the steps you want, then draft again.',
      field: 'prompt',
    } satisfies ActionResult;
  if (!name) return { error: 'Give the flow a name.', field: 'name' } satisfies ActionResult;

  let graph: Pick<Flow, 'nodes' | 'edges'>;
  let description = '';
  let channels: OrderChannel[] = [];
  if (generate) {
    const res = await engine().copilot({ prompt, model });
    if (!res.graph.nodes.length)
      return {
        error: `The assistant could not draft that. ${res.explanation}`,
        field: 'prompt',
      } satisfies ActionResult;
    graph = autoLayout(res.graph);
    description = prompt.slice(0, 300);
  } else if (f.get('from') === 'template') {
    const t = TEMPLATES[DEFAULT_TEMPLATE[model]]();
    graph = { nodes: t.nodes, edges: t.edges };
    description = t.description;
    channels = t.channels;
  } else {
    graph = {
      nodes: [
        {
          id: 'start',
          type: 'trigger.manual',
          label: 'Start',
          config: {},
          position: { x: 56, y: 160 },
        },
      ],
      edges: [],
    };
  }
  const id = slug(name);
  await saveFlow({ id, name, description, model, channels, ...graph });
  await audit(request, 'flow.saved', { actor: me, target: id, detail: { name, via: 'app' } });
  return redirect(`/flows/${id}`);
}

const STARTS = [
  { id: 'template', label: 'Template' },
  { id: 'blank', label: 'Blank' },
  { id: 'generate', label: 'Describe it' },
] as const;
type Start = (typeof STARTS)[number]['id'];

/** An example for the assistant, in the chosen model's terms. */
const EXAMPLES: Record<OrderModel, string> = {
  b2b: 'A purchase order by email: extract the lines, price them on contract, check credit, and ask sales to approve anything over the limit; then reserve stock, ship and invoice.',
  b2c: 'A web order: validate the address, price and tax it, authorize the card, reserve stock, ship, and capture payment when it ships.',
  d2c: 'An order that can be picked up in store: route it to the nearest store with stock, hold it there, tell the customer it is ready, and capture payment at handover.',
  marketplace:
    'A marketplace order: split it by seller, wait for each seller to accept, authorize the card, ship, and pay each seller out net of commission.',
  subscription:
    'A monthly box: authorize the card, then each month charge it, retry once if it fails, and pause the subscription after two failures.',
  procurement:
    'A purchase request: classify the spend, check the budget, ask a manager to approve anything over $5,000, then raise a PO and match the invoice.',
  replenishment:
    'A stock review: forecast demand for low SKUs, raise a PO with the supplier, and restock when the goods arrive.',
};

type Card = Awaited<ReturnType<typeof loader>>['flows'][number];

export default function Flows() {
  const canOperate = useCan('operator');
  const { flows, templates, archived, archivedCount } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>() as ActionResult | null | undefined;
  const nav = useNavigation();
  const [, setParams] = useSearchParams();
  const [start, setStart] = useState<Start>('template');
  const [model, setModel] = useState<OrderModel>('b2c');
  const [filter, setFilter] = useState('');
  const creating =
    nav.state !== 'idle' &&
    nav.formMethod === 'POST' &&
    !['archive', 'restore', 'duplicate'].includes(String(nav.formData?.get('intent') ?? ''));
  const hintId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const formError = data && !data.flowId ? data : null;
  // After the submit settles (the button it disabled gives focus up), take focus to what went wrong.
  useEffect(() => {
    if (!formError) return;
    const t = window.setTimeout(() => alertRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [formError]);

  const q = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = flows.filter(
      (f) =>
        !q ||
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        ORDER_MODEL_LABELS[f.model].toLowerCase().includes(q),
    );
    return (
      [
        ['Selling', SELLING],
        ['Buying', BUY_SIDE_MODELS],
      ] as const
    )
      .map(([side, models]) => ({
        side,
        models: models
          .map((m) => ({ model: m, items: shown.filter((f) => f.model === m) }))
          .filter((g) => g.items.length),
      }))
      .filter((s) => s.models.length);
  }, [flows, q]);

  const hint =
    start === 'template'
      ? `Copies ${templates[model].name}, ${templates[model].steps} steps. You edit it before publishing.`
      : start === 'blank'
        ? 'Starts with a single start step.'
        : 'The assistant drafts the steps from your description. You review them before publishing.';

  return (
    <>
      <PageHeader
        title="Flows"
        subtitle="The process each kind of order follows. Orders keep the version they started on, so edits never change a running order."
        actions={
          canOperate && !archived ? (
            <Button
              size="sm"
              onClick={() => {
                document.getElementById('new-flow')?.scrollIntoView({ block: 'start' });
                nameRef.current?.focus({ preventScroll: true });
              }}
            >
              <Plus aria-hidden="true" /> New flow
            </Button>
          ) : null
        }
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-10 sm:px-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, description or order type"
              aria-label="Filter flows"
              className="h-8 w-full sm:w-80"
            />
            {archived ? (
              <button
                type="button"
                className="text-link text-sm hover:underline"
                onClick={() => setParams({})}
              >
                Back to flows in use
              </button>
            ) : archivedCount ? (
              <button
                type="button"
                className="text-link text-sm hover:underline"
                onClick={() => setParams({ archived: '1' })}
              >
                Archived drafts ({count(archivedCount)})
              </button>
            ) : null}
          </div>
          {archived ? (
            <p className="mb-4 text-muted-foreground text-sm">
              Drafts that were never published, set aside. Restore one to edit it again.
            </p>
          ) : null}

          {groups.length ? (
            <div className="space-y-6">
              {groups.map((s) => (
                <section key={s.side} aria-labelledby={`side-${s.side}`}>
                  <h2 id={`side-${s.side}`} className="caption mb-2 uppercase tracking-wide">
                    {s.side}
                  </h2>
                  <div className="grid items-start gap-x-3 gap-y-5 md:grid-cols-2">
                    {s.models.map((g) => (
                      <section key={g.model} aria-labelledby={`model-${g.model}`}>
                        <h3 id={`model-${g.model}`} className="section-title mb-2">
                          {ORDER_MODEL_LABELS[g.model]}
                        </h3>
                        <ul className="space-y-3">
                          {g.items.map((f) => (
                            <FlowCard
                              key={f.id}
                              f={f}
                              canOperate={canOperate}
                              error={data?.flowId === f.id ? data.error : undefined}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className="rounded-md border bg-card px-4 py-8 text-center text-muted-foreground text-sm">
              {q
                ? `No flow matches “${filter.trim()}”.`
                : archived
                  ? 'No archived drafts.'
                  : 'No flows yet.'}
            </p>
          )}
        </div>

        <aside id="new-flow" className="min-w-0 scroll-mt-20">
          {canOperate && !archived ? (
            <Form method="post" className="space-y-4 rounded-md border bg-card p-4" noValidate>
              <h2 className="section-title">New flow</h2>
              <Field label="Name" hint={start === 'generate' ? 'Optional' : undefined}>
                <Input
                  ref={nameRef}
                  name="name"
                  placeholder="e.g. Weekend flash sale"
                  className="h-8"
                  required={start !== 'generate'}
                  aria-invalid={formError?.field === 'name' || undefined}
                />
              </Field>
              <Field label="Commerce model">
                <NativeSelect
                  name="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value as OrderModel)}
                  wrapperClassName="w-full"
                  className="h-8 w-full"
                >
                  {(
                    [
                      ['Selling', SELLING],
                      ['Buying', BUY_SIDE_MODELS],
                    ] as const
                  ).map(([group, models]) => (
                    <NativeSelectOptGroup key={group} label={group}>
                      {models.map((m: OrderModel) => (
                        <NativeSelectOption key={m} value={m}>
                          {ORDER_MODEL_LABELS[m]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelectOptGroup>
                  ))}
                </NativeSelect>
              </Field>
              <fieldset aria-describedby={hintId}>
                <legend className="caption mb-1.5">Start from</legend>
                <Segmented
                  name="start"
                  aria-label="Start from"
                  value={start}
                  onValueChange={(v) => setStart(v as typeof start)}
                  className="grid w-full"
                >
                  {STARTS.map((o) => (
                    <SegmentedItem key={o.id} value={o.id}>
                      {o.label}
                    </SegmentedItem>
                  ))}
                </Segmented>
                <p id={hintId} className="mt-1.5 text-muted-foreground text-xs" aria-live="polite">
                  {hint}
                </p>
              </fieldset>
              {start === 'generate' ? (
                <Field label="What should happen">
                  <Textarea
                    name="prompt"
                    rows={5}
                    className="text-base md:text-sm"
                    placeholder={EXAMPLES[model]}
                    aria-invalid={formError?.field === 'prompt' || undefined}
                  />
                </Field>
              ) : null}
              {/* The action reads `intent` for AI drafts and `from` for template or blank. */}
              <input type="hidden" name="intent" value={start === 'generate' ? 'generate' : ''} />
              <input type="hidden" name="from" value={start === 'generate' ? '' : start} />
              {formError ? (
                <p
                  ref={alertRef}
                  tabIndex={-1}
                  className="text-bad text-sm outline-none"
                  role="alert"
                >
                  {formError.error}
                </p>
              ) : null}
              <Button type="submit" size="sm" disabled={creating}>
                {start === 'generate'
                  ? creating
                    ? 'Drafting…'
                    : 'Draft the flow'
                  : creating
                    ? 'Creating…'
                    : 'Create flow'}
              </Button>
              <p className="sr-only" aria-live="polite">
                {creating
                  ? start === 'generate'
                    ? 'Drafting the flow.'
                    : 'Creating the flow.'
                  : ''}
              </p>
              <p className="text-muted-foreground text-xs">
                A new flow gets no inbound orders until it is published and routed to; you can
                always start orders on it by hand.
              </p>
            </Form>
          ) : !canOperate ? (
            <p className="rounded-md border bg-card p-4 text-muted-foreground text-sm">
              Operators create and edit flows.
            </p>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function FlowCard({ f, canOperate, error }: { f: Card; canOperate: boolean; error?: string }) {
  const titleId = useId();
  const running = Object.entries(f.running).map(([v, n]) => [Number(v), n] as const);
  const total = running.reduce((s, [, n]) => s + n, 0);
  const older = running.filter(([v]) => v !== f.publishedVersion).reduce((s, [, n]) => s + n, 0);
  const steps = [
    f.summary.approvals.length
      ? `${f.summary.approvals.length === 1 ? 'A person decides' : `${f.summary.approvals.length} people decide`}`
      : null,
    f.summary.waits.length ? `waits for ${f.summary.waits.join(', ')}` : null,
    `${count(f.summary.steps)} steps`,
  ].filter(Boolean);
  return (
    <li
      aria-labelledby={titleId}
      className="relative flex min-w-0 flex-col rounded-md border bg-card p-4 transition-colors hover:border-foreground/30"
    >
      <h4 id={titleId} className="font-medium">
        {/* The whole card opens the flow; the link's name is just the flow's. */}
        <Link
          to={`/flows/${f.id}`}
          className="after:absolute after:inset-0 after:rounded-md hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
        >
          {f.name}
        </Link>
      </h4>
      <p className="mt-0.5 text-xs">
        {f.publishedVersion ? (
          <>
            <span className="font-medium text-foreground">Live v{f.publishedVersion}</span>
            {f.dirty ? <span className="text-wait"> · unpublished changes</span> : null}
            {f.publishedAt ? (
              <span className="text-muted-foreground">
                {' '}
                · published <Ago ms={f.publishedAt} />
              </span>
            ) : null}
          </>
        ) : (
          <span className="font-medium text-muted-foreground">
            Draft, never published · edited <Ago ms={f.updatedAt} />
          </span>
        )}
      </p>
      <p className="mt-2 line-clamp-2 text-muted-foreground text-sm leading-relaxed">
        {f.description || 'No description yet.'}
      </p>
      <dl className="mt-3 space-y-0.5 text-xs">
        <div className="flex gap-1.5">
          <dt className="shrink-0 text-muted-foreground">Receives</dt>
          <dd className={f.receives.lines.length ? 'text-foreground' : 'text-muted-foreground'}>
            {f.receives.lines.length
              ? f.receives.lines.join(' · ')
              : 'No inbound orders. Start them by hand, or route orders to it.'}
            {f.receives.lines.length && !f.publishedVersion ? (
              <span className="text-bad"> Not published, so those orders are refused.</span>
            ) : null}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="shrink-0 text-muted-foreground">Running</dt>
          <dd>
            {total ? (
              <Link
                to={`/orders?flow=${encodeURIComponent(f.id)}`}
                className="relative z-10 text-link hover:underline"
              >
                {count(total)} {total === 1 ? 'order' : 'orders'}
                {older ? ` (${count(older)} on older versions)` : ''}
              </Link>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="shrink-0 text-muted-foreground">Steps</dt>
          <dd className="text-muted-foreground">{steps.join(' · ')}</dd>
        </div>
      </dl>
      {canOperate ? (
        <div className="relative z-10 mt-3 flex flex-wrap gap-2 border-t pt-3">
          <Form method="post">
            <input type="hidden" name="flowId" value={f.id} />
            <Button
              type="submit"
              name="intent"
              value="duplicate"
              size="xs"
              variant="ghost"
              aria-label={`Duplicate ${f.name}`}
            >
              Duplicate
            </Button>
          </Form>
          {!f.publishedVersion ? (
            <Form method="post">
              <input type="hidden" name="flowId" value={f.id} />
              <Button
                type="submit"
                name="intent"
                value={f.archivedAt ? 'restore' : 'archive'}
                size="xs"
                variant="ghost"
                aria-label={`${f.archivedAt ? 'Restore' : 'Archive'} ${f.name}`}
              >
                {f.archivedAt ? 'Restore' : 'Archive'}
              </Button>
            </Form>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="relative z-10 mt-2 text-bad text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
