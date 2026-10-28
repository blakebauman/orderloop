/**
 * Carts: lists of lines people build together before they become an order. Each one lives in a
 * CartAgent in the engine; this page lists the D1 index those agents keep, and opens new ones.
 */

import { ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Card } from '@orderloop/ui/card';
import { Field, FieldGroup, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { ShoppingCart } from 'lucide-react';
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Ago } from '~/components/ago';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { type Tone, ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { cartOpens } from '~/lib/carts';
import { cartFlows, isCartStatus, listCarts } from '~/lib/carts.server';
import { engine } from '~/lib/env.server';
import { ensureSeeded } from '~/lib/flows.server';
import { commerceData, customerNames } from '~/lib/orders.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/carts';

export const meta = () => [{ title: 'Carts · OrderLoop' }];

const STATUS_LABELS = {
  open: 'Open',
  locked: 'Locked',
  submitted: 'Submitted',
  returned: 'Returned',
  canceled: 'Cancelled',
} as const;
type CartStatus = keyof typeof STATUS_LABELS;

/**
 * An open or locked cart waits on its buyer; a submitted one became an order. Returned (sent back
 * to the buyer's system) and cancelled ones are over without succeeding at anything, so neutral.
 */
const CART_TONE: Record<CartStatus, Tone> = {
  open: 'wait',
  locked: 'wait',
  submitted: 'ok',
  returned: 'idle',
  canceled: 'idle',
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  await ensureSeeded();
  const q = new URL(request.url).searchParams.get('status');
  const [rows, flows, office] = await Promise.all([
    listCarts({ status: isCartStatus(q) ? q : undefined }),
    cartFlows(),
    commerceData(),
  ]);
  return {
    // A row with no CartAgent behind it would open on "Not found": listed, but not linked.
    carts: rows.map((c) => ({ ...c, opens: cartOpens(c.id) })),
    names: await customerNames(rows.map((c) => c.customerId)),
    flows,
    customers: office.customers.map(({ id, name }) => ({ id, name })),
    status: isCartStatus(q) ? q : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const f = await request.formData();
  const made = await engine().createCart({
    title: String(f.get('title') ?? ''),
    flowId: String(f.get('flowId') ?? ''),
    customerId: String(f.get('customerId') ?? '') || null,
    createdBy: me.id,
  });
  if (!made.ok) return { error: made.error };
  return redirect(`/carts/${made.id}`);
}

export default function Carts() {
  const { carts, names, flows, customers, status } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const canOperate = useCan('operator');

  // A new cart's page opens once it's made, so success never comes back here; a refusal keeps the
  // sheet open with what was typed.
  const sheet = useFormSheet(result, () => false);

  return (
    <>
      <PageHeader
        title="Carts"
        subtitle="Build an order together: everyone with a cart open sees each change as it happens, and it is priced by its flow before it is submitted."
        actions={
          canOperate ? (
            <FormSheet open={sheet.open} onOpenChange={sheet.onOpenChange} label="New cart">
              <NewCart
                flows={flows}
                customers={customers}
                error={sheet.result?.error ?? null}
                busy={busy}
              />
            </FormSheet>
          ) : null
        }
      />
      <Body className="grid gap-4">
        <nav aria-label="Filter by status" className="flex flex-wrap gap-1 text-sm">
          <FilterLink to="/carts" active={!status}>
            All
          </FilterLink>
          {Object.entries(STATUS_LABELS).map(([s, label]) => (
            <FilterLink key={s} to={`/carts?status=${s}`} active={status === s}>
              {label}
            </FilterLink>
          ))}
        </nav>

        {carts.length ? (
          <Section
            title={status ? `${STATUS_LABELS[status]} carts` : 'All carts'}
            description="Most recently changed first."
          >
            <ul className="-mx-2 flex flex-col gap-1">
              {carts.map((c) => (
                <CartItem
                  key={c.id}
                  c={c}
                  customer={(c.customerId && names[c.customerId]) || 'No customer'}
                />
              ))}
            </ul>
          </Section>
        ) : (
          <Card className="py-0">
            <Empty icon={<ShoppingCart aria-hidden="true" />}>
              {status ? `No ${STATUS_LABELS[status].toLowerCase()} carts.` : 'No carts yet.'}
            </Empty>
          </Card>
        )}
      </Body>
    </>
  );
}

/**
 * One cart, read as a row: its title (the whole item opens the cart, if it opens), who it is for
 * and what became of it, then its status and when it last changed.
 */
function CartItem({
  c,
  customer,
}: {
  c: ReturnType<typeof useLoaderData<typeof loader>>['carts'][number];
  customer: string;
}) {
  return (
    <Item
      asChild
      size="xs"
      className={cn('relative items-start px-2', c.opens && 'hover:bg-muted/60')}
    >
      <li>
        <ItemMedia variant="icon" className="mt-0.5 self-start text-muted-foreground">
          <ShoppingCart aria-hidden="true" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            {c.opens ? (
              <Link
                to={`/carts/${c.id}`}
                className="truncate after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
              >
                {c.title}
              </Link>
            ) : (
              <span className="truncate">{c.title}</span>
            )}
          </ItemTitle>
          <ItemDescription className="text-xs">
            {customer}
            {c.opens ? null : ' · Recorded only: no live cart to open.'}
            {c.orderId ? (
              <>
                {' · Became '}
                <Link
                  to={`/orders/${c.orderId}`}
                  className="relative z-10 text-link no-underline! hover:underline!"
                >
                  an order
                </Link>
              </>
            ) : null}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="flex-col items-end gap-1 self-start">
          <ToneBadge
            tone={CART_TONE[c.status as CartStatus] ?? 'idle'}
            label={STATUS_LABELS[c.status as CartStatus] ?? c.status}
          />
          <span className="text-muted-foreground text-xs">
            <Ago ms={c.updatedAt} />
          </span>
        </ItemActions>
      </li>
    </Item>
  );
}

/** The fields of a new cart; the engine checks them (`createCart`). */
function NewCart({
  flows,
  customers,
  error,
  busy,
}: {
  flows: { id: string; name: string; model: string }[];
  customers: { id: string; name: string }[];
  error: string | null;
  busy: boolean;
}) {
  return (
    <Form method="post" className="grid gap-4 text-sm">
      <FieldGroup className="gap-4">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="cart-title">Title</FieldLabel>
          <Input
            id="cart-title"
            name="title"
            required
            maxLength={120}
            placeholder="Q4 restock"
            className="h-8"
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="cart-flow">Flow</FieldLabel>
          <NativeSelect id="cart-flow" name="flowId" required className="h-8 w-full">
            {flows.map((f) => (
              <NativeSelectOption key={f.id} value={f.id}>
                {f.name} · {ORDER_MODEL_LABELS[f.model as OrderModel] ?? f.model}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="cart-customer">Customer</FieldLabel>
          <NativeSelect id="cart-customer" name="customerId" className="h-8 w-full">
            <NativeSelectOption value="">No customer</NativeSelectOption>
            {customers.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </FieldGroup>
      {!flows.length ? (
        <p className="text-muted-foreground text-xs">
          Publish a flow with a Price lines step to open carts on it.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-bad">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={busy || !flows.length}>
          Open cart
        </Button>
      </div>
    </Form>
  );
}

function FilterLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className="hit-area rounded-4xl border border-input bg-input/30 px-3 py-1 text-muted-foreground hover:bg-input/50 hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
    >
      {children}
    </Link>
  );
}
