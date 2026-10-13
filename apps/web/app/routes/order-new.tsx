import { ORDER_TYPE_LABELS, type OrderLine, type OrderType } from '@orderloop/core';
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
import { backOffice, publishedFlows } from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import type { Route } from './+types/order-new';

export const meta = () => [{ title: 'New order · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  await ensureSeeded();
  const [flows, office] = await Promise.all([publishedFlows(), backOffice()]);
  return { flows, customers: office.customers, products: office.products };
}

/** "WID-100 x 50" / "50 WID-100" / "WID-100, 50" per line. */
function parseLines(text: string): OrderLine[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sku = /[A-Z]{2,4}-\d{2,4}/i.exec(l)?.[0]?.toUpperCase();
      const qty = Number(/(\d+(?:\.\d+)?)(?!.*\d)/.exec(l.replace(sku ?? '', ''))?.[1] ?? 1);
      return sku ? { sku, qty } : null;
    })
    .filter((x): x is OrderLine => !!x);
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);
  const f = await request.formData();
  const flowId = String(f.get('flowId') ?? '');
  const flows = await publishedFlows();
  const flow = flows.find((x) => x.id === flowId);
  if (!flow) return { error: 'Pick a published flow.' };
  const simulate = String(f.get('simulate') ?? '');
  try {
    const { orderId } = await engine().startOrder({
      flowId,
      input: {
        type: flow.orderType as OrderType,
        title: String(f.get('title') ?? '') || undefined,
        customerId: String(f.get('customerId') ?? '') || undefined,
        currency: 'USD',
        lines: parseLines(String(f.get('lines') ?? '')),
        documentText: String(f.get('documentText') ?? '') || undefined,
        meta: simulate ? { simulate } : {},
      },
    });
    return redirect(`/orders/${orderId}`);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default function NewOrder() {
  const { flows, customers, products } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const [preset, setPreset] = useState(SCENARIOS[0]!);
  const [key, setKey] = useState(0);
  const pick = (id: string) => {
    const s = SCENARIOS.find((x) => x.id === id);
    if (s) {
      setPreset(s);
      setKey((k) => k + 1);
    }
  };
  return (
    <>
      <PageHeader
        title="New order"
        subtitle="Start an order on a published flow. Presets fill the form with a demo scenario."
      />
      <div className="mx-auto grid max-w-[1400px] gap-6 px-6 pb-10 lg:grid-cols-[1fr_320px]">
        <Form method="post" key={key} className="space-y-4 rounded-md border bg-card p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Flow">
              <NativeSelect name="flowId" defaultValue={preset.flowId} className="h-9 w-full">
                {flows.map((fl) => (
                  <NativeSelectOption key={fl.id} value={fl.id}>
                    {fl.name} · {ORDER_TYPE_LABELS[fl.orderType as OrderType]} · v{fl.version}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Customer" hint="blank lets AI extraction find it">
              <NativeSelect
                name="customerId"
                defaultValue={preset.input.customerId ?? ''}
                className="h-9 w-full"
              >
                <NativeSelectOption value="">—</NativeSelectOption>
                {customers.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name} ({c.tier})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Title">
            <Input name="title" defaultValue={preset.input.title ?? ''} placeholder="Optional" />
          </Field>
          <Field label="Lines" hint="one per line: SKU x qty">
            <Textarea
              name="lines"
              rows={4}
              className="font-mono text-xs"
              defaultValue={preset.input.lines.map((l) => `${l.sku} x ${l.qty}`).join('\n')}
            />
          </Field>
          <Field label="Inbound document" hint="email or PO text for the AI extract node">
            <Textarea
              name="documentText"
              rows={6}
              className="text-xs"
              defaultValue={preset.input.documentText ?? ''}
            />
          </Field>
          <Field label="Simulate" hint="force a connector failure">
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
          {data?.error ? <p className="text-destructive text-sm">{data.error}</p> : null}
          <Button type="submit" disabled={nav.state !== 'idle'}>
            {nav.state !== 'idle' ? 'Starting…' : 'Start order'}
          </Button>
        </Form>
        <aside className="space-y-4">
          <div className="rounded-md border bg-card p-4">
            <h2 className="mb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              Presets
            </h2>
            <div className="space-y-1">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pick(s.id)}
                  className={`w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted/60 ${preset.id === s.id ? 'bg-primary/10 text-primary' : ''}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-md border bg-card p-4">
            <h2 className="mb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              Catalog
            </h2>
            <ul className="space-y-1 text-xs">
              {products.map((p) => (
                <li key={p.sku} className="flex justify-between gap-2">
                  <span>
                    <span className="font-mono">{p.sku}</span>{' '}
                    <span className="text-muted-foreground">{p.name}</span>
                  </span>
                  <span className="text-muted-foreground tabular">{p.stock - p.reserved}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
