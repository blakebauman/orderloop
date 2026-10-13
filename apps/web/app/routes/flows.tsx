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
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Field } from '~/components/inspector';
import { PageHeader } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { listFlows, saveFlow } from '~/lib/flows.server';
import { ago } from '~/lib/format';
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
    if (!prompt) return { error: 'Describe the process you want.' };
    const res = await engine().copilot({ prompt, orderType });
    if (!res.graph.nodes.length)
      return { error: `The copilot could not draft that: ${res.explanation}` };
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

export default function Flows() {
  const { flows } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  return (
    <>
      <PageHeader
        title="Flows"
        subtitle="Each flow is a graph the OrderLoop Workflow interprets. Orders pin the version they started on."
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-6 pb-10 xl:grid-cols-[1fr_360px]">
        <div className="grid content-start gap-3 md:grid-cols-2">
          {flows.map((f) => (
            <Link
              key={f.id}
              to={`/flows/${f.id}`}
              className="group rounded-md border bg-card p-4 transition hover:border-primary/40"
            >
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-primary" />
                <span className="font-medium">{f.name}</span>
                <span className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                  {f.publishedVersion ? `v${f.publishedVersion}` : 'draft'}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-muted-foreground text-xs leading-relaxed">
                {f.description || 'No description.'}
              </p>
              <div className="mt-3 text-[11px] text-muted-foreground">
                {ORDER_TYPE_LABELS[f.orderType as OrderType]} · {f.nodeCount} nodes · edited{' '}
                {ago(f.updatedAt)}
              </div>
            </Link>
          ))}
        </div>
        <aside className="space-y-4">
          <Form method="post" className="space-y-3 rounded-md border bg-card p-4">
            <h2 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              New flow
            </h2>
            <Field label="Name">
              <Input name="name" placeholder="Wholesale reorder" className="h-8" />
            </Field>
            <Field label="Order type">
              <NativeSelect name="orderType" className="h-8 w-full">
                {ORDER_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {ORDER_TYPE_LABELS[t]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <div className="flex gap-2">
              <Button type="submit" name="from" value="template" size="sm" variant="outline">
                From template
              </Button>
              <Button type="submit" name="from" value="blank" size="sm" variant="ghost">
                Blank
              </Button>
            </div>
          </Form>
          <Form method="post" className="space-y-3 rounded-md border border-ai/25 bg-card p-4">
            <h2 className="flex items-center gap-1.5 font-medium text-[11px] text-ai uppercase tracking-wide">
              <Sparkles className="size-3.5" /> Describe it
            </h2>
            <input type="hidden" name="intent" value="generate" />
            <Field label="Name">
              <Input name="name" placeholder="Marketplace order" className="h-8" />
            </Field>
            <Field label="Order type">
              <NativeSelect name="orderType" className="h-8 w-full">
                {ORDER_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {ORDER_TYPE_LABELS[t]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Textarea
              name="prompt"
              rows={5}
              className="text-xs"
              placeholder="A marketplace webhook order: validate, price, risk-score it; high risk needs approval, otherwise authorize the card, reserve stock, ship, and capture payment."
            />
            {data?.error ? <p className="text-bad text-xs">{data.error}</p> : null}
            <Button type="submit" size="sm" disabled={nav.state !== 'idle'}>
              {nav.state !== 'idle' ? 'Drafting…' : 'Draft with Workers AI'}
            </Button>
          </Form>
        </aside>
      </div>
    </>
  );
}
