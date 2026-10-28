/**
 * Carts: lists of lines people build together before they become an order. Each one lives in a
 * CartAgent in the engine; this page lists the D1 index those agents keep, and opens new ones.
 */

import { ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Ago } from '~/components/ago';
import { Body, Empty, PageHeader } from '~/components/page';
import { type Tone, ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
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

/** An open or locked cart waits on its buyer; submitted and returned ones are done with. */
const CART_TONE: Record<CartStatus, Tone> = {
  open: 'wait',
  locked: 'wait',
  submitted: 'ok',
  returned: 'ok',
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
    carts: rows,
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

  return (
    <>
      <PageHeader
        title="Carts"
        subtitle="Build an order together: everyone with a cart open sees each change as it happens, and it is priced by its flow before it is submitted."
      />
      <Body className="grid gap-4">
        {canOperate ? (
          <Form method="post" className="flex flex-wrap items-end gap-2 card p-4">
            <div className="grid gap-1 text-sm">
              <label htmlFor="cart-title" className="caption">
                Title
              </label>
              <Input
                id="cart-title"
                name="title"
                required
                maxLength={120}
                placeholder="Q4 restock"
                className="h-8 w-64"
              />
            </div>
            <div className="grid gap-1 text-sm">
              <label htmlFor="cart-flow" className="caption">
                Flow
              </label>
              <NativeSelect id="cart-flow" name="flowId" required className="h-8 w-56">
                {flows.map((f) => (
                  <NativeSelectOption key={f.id} value={f.id}>
                    {f.name} · {ORDER_MODEL_LABELS[f.model as OrderModel] ?? f.model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1 text-sm">
              <label htmlFor="cart-customer" className="caption">
                Customer
              </label>
              <NativeSelect id="cart-customer" name="customerId" className="h-8 w-56">
                <NativeSelectOption value="">No customer</NativeSelectOption>
                {customers.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" size="sm" disabled={busy || !flows.length}>
              New cart
            </Button>
            {!flows.length ? (
              <p className="w-full text-muted-foreground text-xs">
                Publish a flow with a Price lines step to open carts on it.
              </p>
            ) : null}
            {result?.error ? (
              <p role="alert" className="w-full text-bad text-sm">
                {result.error}
              </p>
            ) : null}
          </Form>
        ) : null}

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
          <div className="card overflow-clip">
            <Table stack="rows" caption="Carts">
              <TableHead>
                <Tr>
                  <Th>Cart</Th>
                  <Th>Status</Th>
                  <Th>Customer</Th>
                  <Th numeric>Updated</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {carts.map((c) => (
                  // On a phone the row is a card, and the whole card opens the cart.
                  <Tr
                    key={c.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-muted/40 max-md:relative max-md:active:bg-muted/60 md:table-row md:p-0"
                  >
                    <Td className="min-w-0">
                      <Link
                        to={`/carts/${c.id}`}
                        className="font-medium hover:underline max-md:after:absolute max-md:after:inset-0"
                      >
                        {c.title}
                      </Link>
                      {c.orderId ? (
                        <div className="text-muted-foreground text-xs">
                          Became{' '}
                          <Link
                            to={`/orders/${c.orderId}`}
                            className="relative z-10 text-link hover:underline"
                          >
                            an order
                          </Link>
                        </div>
                      ) : null}
                    </Td>
                    <Td className="col-start-2 row-start-1 text-right md:text-left">
                      <ToneBadge
                        tone={CART_TONE[c.status as CartStatus] ?? 'idle'}
                        label={STATUS_LABELS[c.status as CartStatus] ?? c.status}
                      />
                    </Td>
                    <Td className="truncate text-muted-foreground text-xs md:text-sm">
                      {(c.customerId && names[c.customerId]) || 'No customer'}
                    </Td>
                    <Td numeric className="text-muted-foreground text-xs md:text-sm">
                      <Ago ms={c.updatedAt} />
                    </Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <Empty>
              {status ? `No ${STATUS_LABELS[status].toLowerCase()} carts.` : 'No carts yet.'}
            </Empty>
          </div>
        )}
      </Body>
    </>
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
      className="rounded-md border px-2.5 py-1 text-muted-foreground aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground"
    >
      {children}
    </Link>
  );
}
