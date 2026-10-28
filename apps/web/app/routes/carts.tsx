/**
 * Carts: lists of lines people build together before they become an order. Each one lives in a
 * CartAgent in the engine; this page lists the D1 index those agents keep, and opens new ones.
 */

import { ORDER_MODEL_LABELS, type OrderModel } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Ago } from '~/components/ago';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Body, Empty, PageHeader } from '~/components/page';
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
          <div className="card relative overflow-clip">
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
                  // On a phone the row is a card, and the whole card opens the cart (if it opens).
                  <Tr
                    key={c.id}
                    className={cn(
                      'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 max-md:relative md:table-row md:p-0',
                      c.opens && 'hover:bg-muted/40 max-md:active:bg-muted/60',
                    )}
                  >
                    <Td className="min-w-0">
                      {c.opens ? (
                        <Link
                          to={`/carts/${c.id}`}
                          className="font-medium hover:underline max-md:after:absolute max-md:after:inset-0"
                        >
                          {c.title}
                        </Link>
                      ) : (
                        <>
                          <span className="font-medium">{c.title}</span>
                          <div className="text-muted-foreground text-xs">
                            Recorded only: no live cart to open.
                          </div>
                        </>
                      )}
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
    <Form method="post" className="grid gap-3 text-sm">
      <div className="grid gap-1">
        <label htmlFor="cart-title" className="caption">
          Title
        </label>
        <Input
          id="cart-title"
          name="title"
          required
          maxLength={120}
          placeholder="Q4 restock"
          className="h-8"
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor="cart-flow" className="caption">
          Flow
        </label>
        <NativeSelect id="cart-flow" name="flowId" required className="h-8 w-full">
          {flows.map((f) => (
            <NativeSelectOption key={f.id} value={f.id}>
              {f.name} · {ORDER_MODEL_LABELS[f.model as OrderModel] ?? f.model}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <label htmlFor="cart-customer" className="caption">
          Customer
        </label>
        <NativeSelect id="cart-customer" name="customerId" className="h-8 w-full">
          <NativeSelectOption value="">No customer</NativeSelectOption>
          {customers.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
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
