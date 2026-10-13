import {
  autoLayout,
  ORDER_TYPE_LABELS,
  ORDER_TYPES,
  type OrderType,
  TEMPLATES,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Textarea } from '@orderloop/ui/textarea';
import { GitBranch, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Ago } from '~/components/ago';
import { Field } from '~/components/inspector';
import { PageHeader } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { listFlows, saveFlow } from '~/lib/flows.server';
import type { Route } from './+types/flows';

export const meta = () => [{ title: 'Flows · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return { flows: await listFlows() };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const f = await request.formData();
  const name = String(f.get('name') ?? '').trim() || 'Untitled flow';
  const orderType = (
    ORDER_TYPES.includes(f.get('orderType') as OrderType) ? f.get('orderType') : 'b2b_order'
  ) as OrderType;
  const id = `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'flow'
  }-${Date.now().toString(36).slice(-4)}`;
  let graph = {
    nodes: [] as ReturnType<(typeof TEMPLATES)[OrderType]>['nodes'],
    edges: [] as ReturnType<(typeof TEMPLATES)[OrderType]>['edges'],
  };
  let description = '';
  if (f.get('intent') === 'generate') {
    const prompt = String(f.get('prompt') ?? '').trim();
    if (!prompt) return { error: 'Describe the steps you want, then draft again.' };
    const res = await engine().copilot({ prompt, orderType });
    if (!res.graph.nodes.length)
      return { error: `The copilot could not draft that. ${res.explanation}` };
    graph = autoLayout(res.graph);
    description = prompt.slice(0, 300);
  } else if (f.get('from') === 'template') {
    const t = TEMPLATES[orderType]();
    graph = { nodes: t.nodes, edges: t.edges };
    description = t.description;
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
  await saveFlow({ id, name, description, orderType, ...graph });
  return redirect(`/flows/${id}`);
}

const STARTS = [
  { id: 'template', label: 'Template', hint: 'The standard flow for this order type' },
  { id: 'blank', label: 'Blank', hint: 'Just a start node' },
  { id: 'generate', label: 'Describe it', hint: 'Workers AI drafts the graph' },
] as const;

export default function Flows() {
  const { flows } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const [start, setStart] = useState<(typeof STARTS)[number]['id']>('template');
  const busy = nav.state !== 'idle';
  return (
    <>
      <PageHeader
        title="Flows"
        subtitle="The process each order type follows. Orders keep the version they started on, so edits never change a running order."
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-10 sm:px-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 content-start gap-3 md:grid-cols-2">
          {flows.map((f) => (
            <Link
              key={f.id}
              to={`/flows/${f.id}`}
              className="group min-w-0 rounded-md border bg-card p-4 transition-colors hover:border-foreground/30"
            >
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate font-medium">{f.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                  {f.publishedVersion ? `v${f.publishedVersion}` : 'Draft'}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-muted-foreground text-sm leading-relaxed">
                {f.description || 'No description yet.'}
              </p>
              <div className="mt-3 text-muted-foreground text-xs">
                {ORDER_TYPE_LABELS[f.orderType as OrderType]} · {f.nodeCount} nodes · edited{' '}
                <Ago ms={f.updatedAt} />
              </div>
            </Link>
          ))}
        </div>
        <aside className="min-w-0">
          <Form method="post" className="space-y-4 rounded-md border bg-card p-4">
            <h2 className="section-title">New flow</h2>
            <Field label="Name">
              <Input name="name" placeholder="e.g. Wholesale reorder" className="h-8" />
            </Field>
            <Field label="Order type">
              <NativeSelect name="orderType" className="h-8 w-full" defaultValue="b2b_order">
                {ORDER_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {ORDER_TYPE_LABELS[t]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <fieldset>
              <legend className="caption mb-1.5">Start from</legend>
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-[var(--rule)] text-[13px]">
                {STARTS.map((o) => (
                  <label
                    key={o.id}
                    className="cursor-pointer bg-card px-2 py-1.5 text-center text-muted-foreground has-[:checked]:bg-primary has-[:checked]:font-medium has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--ring)]"
                  >
                    <input
                      type="radio"
                      name="start"
                      value={o.id}
                      checked={start === o.id}
                      onChange={() => setStart(o.id)}
                      className="sr-only"
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-muted-foreground text-xs">
                {STARTS.find((o) => o.id === start)?.hint}
              </p>
            </fieldset>
            {start === 'generate' ? (
              <Field label="What should happen">
                <Textarea
                  name="prompt"
                  rows={5}
                  className="text-sm"
                  placeholder="A marketplace order: validate, price and risk-score it. High risk needs approval; otherwise authorize the card, reserve stock, ship, and capture payment."
                />
              </Field>
            ) : null}
            {/* The action reads `intent` for AI drafts and `from` for template or blank. */}
            <input type="hidden" name="intent" value={start === 'generate' ? 'generate' : ''} />
            <input type="hidden" name="from" value={start === 'generate' ? '' : start} />
            {data?.error ? (
              <p className="text-bad text-sm" role="alert">
                {data.error}
              </p>
            ) : null}
            <Button type="submit" size="sm" disabled={busy}>
              {start === 'generate' ? (
                <>
                  <Sparkles /> {busy ? 'Drafting…' : 'Draft the flow'}
                </>
              ) : busy ? (
                'Creating…'
              ) : (
                'Create flow'
              )}
            </Button>
          </Form>
        </aside>
      </div>
    </>
  );
}
