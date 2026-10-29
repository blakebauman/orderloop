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
import { Badge } from '@orderloop/ui/badge';
import { Button } from '@orderloop/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@orderloop/ui/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@orderloop/ui/native-select';
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { Textarea } from '@orderloop/ui/textarea';
import { PencilLine, Search, Workflow } from 'lucide-react';
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
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Body, Empty, PageHeader } from '~/components/page';
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

type FlowRow = Awaited<ReturnType<typeof loader>>['flows'][number];

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
  const nameId = useId();
  const modelId = useId();
  const promptId = useId();
  const alertRef = useRef<HTMLParagraphElement>(null);
  // A new flow redirects to its editor; a refusal keeps the sheet open with what was typed.
  const sheet = useFormSheet(data ?? undefined, () => false);
  const formError = sheet.result && !sheet.result.flowId ? sheet.result : null;
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
            <FormSheet open={sheet.open} onOpenChange={sheet.onOpenChange} label="New flow">
              <Form method="post" noValidate>
                <FieldGroup className="gap-5">
                  <Field>
                    <div className="flex items-baseline justify-between gap-2">
                      <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                      {start === 'generate' ? (
                        <span className="text-muted-foreground text-xs">Optional</span>
                      ) : null}
                    </div>
                    <Input
                      id={nameId}
                      name="name"
                      placeholder="e.g. Weekend flash sale"
                      className="h-8"
                      required={start !== 'generate'}
                      aria-invalid={formError?.field === 'name' || undefined}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={modelId}>Commerce model</FieldLabel>
                    <NativeSelect
                      id={modelId}
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
                  <FieldSet aria-describedby={hintId} className="gap-0">
                    <FieldLegend variant="label" className="mb-2">
                      Start from
                    </FieldLegend>
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
                    <FieldDescription
                      id={hintId}
                      className="mt-2 text-xs last:mt-2"
                      aria-live="polite"
                    >
                      {hint}
                    </FieldDescription>
                  </FieldSet>
                  {start === 'generate' ? (
                    <Field>
                      <FieldLabel htmlFor={promptId}>What should happen</FieldLabel>
                      <Textarea
                        id={promptId}
                        name="prompt"
                        rows={5}
                        className="text-base md:text-sm"
                        placeholder={EXAMPLES[model]}
                        aria-invalid={formError?.field === 'prompt' || undefined}
                      />
                    </Field>
                  ) : null}
                  {/* The action reads `intent` for AI drafts and `from` for template or blank. */}
                  <input
                    type="hidden"
                    name="intent"
                    value={start === 'generate' ? 'generate' : ''}
                  />
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
                  <Button type="submit" size="sm" className="self-start" disabled={creating}>
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
                  <FieldDescription className="text-xs">
                    A new flow gets no inbound orders until it is published and routed to; you can
                    always start orders on it by hand.
                  </FieldDescription>
                </FieldGroup>
              </Form>
            </FormSheet>
          ) : null
        }
      />
      <Body>
        {/* The toolbar (release-catalog's): the filter, and the way to the archived drafts. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="relative w-full sm:w-80">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, description or order type"
              aria-label="Filter flows"
              className="h-8 w-full pl-9"
            />
          </div>
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
          <div className="space-y-8">
            {groups.map((s) => (
              <section key={s.side} aria-labelledby={`side-${s.side}`}>
                <h2 id={`side-${s.side}`} className="caption mb-3 uppercase tracking-wide">
                  {s.side}
                </h2>
                {/* A card per order model: its template in the header, then its flows. */}
                <div className="grid items-start gap-4 md:grid-cols-2">
                  {s.models.map((g) => (
                    <section key={g.model} aria-labelledby={`model-${g.model}`} className="min-w-0">
                      <Card className="gap-4 [--card-spacing:--spacing(5)]">
                        <CardHeader>
                          <CardTitle className="section-title">
                            <h3 id={`model-${g.model}`}>{ORDER_MODEL_LABELS[g.model]}</h3>
                          </CardTitle>
                          <CardDescription>
                            Template: {templates[g.model].name}, {templates[g.model].steps} steps
                          </CardDescription>
                          <CardAction className="self-center">
                            <Badge variant="secondary" className="tabular">
                              {g.items.length} {g.items.length === 1 ? 'flow' : 'flows'}
                            </Badge>
                          </CardAction>
                        </CardHeader>
                        <CardContent>
                          <ul className="flex flex-col gap-2">
                            {g.items.map((f) => (
                              <FlowItem
                                key={f.id}
                                f={f}
                                canOperate={canOperate}
                                error={data?.flowId === f.id ? data.error : undefined}
                              />
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    </section>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <Card>
            <Empty icon={q ? undefined : <Workflow aria-hidden="true" />}>
              {q
                ? `No flow matches “${filter.trim()}”.`
                : archived
                  ? 'No archived drafts.'
                  : 'No flows yet.'}
            </Empty>
          </Card>
        )}
      </Body>
    </>
  );
}

/**
 * One flow, as a muted Item (the release-catalog row): its version as the tile, then its name (the
 * link, stretched over the Item), state, description and what it receives and runs, and its actions
 * in the footer, above the link.
 */
function FlowItem({ f, canOperate, error }: { f: FlowRow; canOperate: boolean; error?: string }) {
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
    <Item asChild variant="muted" size="sm" className="relative items-start hover:bg-muted">
      <li aria-labelledby={titleId}>
        {/* The live version at a glance; the line under the name says it in words. */}
        <ItemMedia aria-hidden="true">
          <span className="flex size-11 items-center justify-center rounded-xl border bg-card font-semibold text-sm tabular">
            {f.publishedVersion ? (
              `v${f.publishedVersion}`
            ) : (
              <PencilLine className="size-4 text-muted-foreground" />
            )}
          </span>
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <h4 id={titleId} className="min-w-0 truncate">
              {/* The whole item opens the flow; the link's name is just the flow's. */}
              <Link
                to={`/flows/${f.id}`}
                className="after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
              >
                {f.name}
              </Link>
            </h4>
          </ItemTitle>
          <p className="text-xs">
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
          <ItemDescription className="mt-1 leading-relaxed">
            {f.description || 'No description yet.'}
          </ItemDescription>
          <dl className="mt-2 space-y-0.5 text-xs">
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
        </ItemContent>
        {canOperate ? (
          <ItemFooter className="relative z-10 justify-start border-t pt-2">
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
          </ItemFooter>
        ) : null}
        {error ? (
          <p className="relative z-10 basis-full text-bad text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </li>
    </Item>
  );
}
