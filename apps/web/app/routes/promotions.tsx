/**
 * Promotion codes: what each takes off, its limits and how often it has been used. Codes reach an
 * order from a cart (or `meta.promoCodes`); a flow applies them with an Apply promotions step.
 */

import { BASE_CURRENCY } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Fragment, type ReactNode } from 'react';
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { ToneBadge } from '~/components/status';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { dateTime, money, plural } from '~/lib/format';
import { customerNames } from '~/lib/orders.server';
import { promotionState } from '~/lib/promotions';
import {
  createPromotion,
  listPromotions,
  promotionFrom,
  setPromotionStatus,
} from '~/lib/promotions.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/promotions';

export const meta = () => [{ title: 'Promotions · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const promotions = await listPromotions();
  // One clock for the page, so the server and the hydrating browser agree on what has ended.
  return {
    promotions,
    customers: await customerNames(promotions.map((p) => p.customerId)),
    now: Date.now(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const f = await request.formData();
  if (f.get('intent') === 'status') {
    const id = String(f.get('id') ?? '');
    const status = f.get('status') === 'paused' ? 'paused' : 'active';
    await setPromotionStatus(id, status);
    await audit(request, 'promotion.saved', {
      actor: me,
      target: id,
      detail: { status, via: 'app' },
    });
    return { ok: true as const };
  }
  const p = promotionFrom(f);
  if (typeof p === 'string') return { error: p };
  try {
    const id = await createPromotion(p, me.id);
    await audit(request, 'promotion.saved', {
      actor: me,
      target: id,
      detail: { code: p.code, kind: p.kind, value: p.value, via: 'app' },
    });
    return { ok: true as const };
  } catch {
    return { error: `${p.code} already exists.` };
  }
}

const describe = (p: { kind: string; value: number; currency: string | null }) =>
  p.kind === 'pct'
    ? `${p.value}% off`
    : p.kind === 'amount'
      ? `${money(p.value, p.currency ?? BASE_CURRENCY)} off`
      : 'Free shipping';

export default function Promotions() {
  const { promotions, customers, now } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const canOperate = useCan('operator');
  // A code added closes the form; a refusal keeps it open with what was typed. Nothing else on the
  // page can be submitted while the sheet is open, so an `ok` then is the new code.
  const sheet = useFormSheet(result, (r) => 'ok' in r);
  return (
    <>
      <PageHeader
        title="Promotions"
        crumbs={
          <Link to="/commerce#pricing" className="hover:underline">
            Commerce
          </Link>
        }
        subtitle="Codes buyers and staff enter on a cart. A flow applies them with an Apply promotions step, after Price lines and before Calculate tax."
        actions={
          canOperate ? (
            <FormSheet open={sheet.open} onOpenChange={sheet.onOpenChange} label="New promotion">
              <NewPromotion
                error={sheet.result && 'error' in sheet.result ? sheet.result.error : null}
                busy={busy}
              />
            </FormSheet>
          ) : null
        }
      />
      <Body className="grid gap-4">
        <Section
          title="Codes"
          description="What each code takes off, its limits and how often it has been used."
          flush
        >
          {promotions.length ? (
            <Table stack="cards" caption="Promotion codes">
              <TableHead>
                <Tr>
                  <Th>Code</Th>
                  <Th>Takes off</Th>
                  <Th>Limits</Th>
                  <Th numeric>Used</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </Tr>
              </TableHead>
              <TableBody>
                {promotions.map((p) => {
                  const paused = p.status === 'paused';
                  const state = promotionState(p, now);
                  const limits: ReactNode[] = [
                    p.minSubtotal ? `over ${money(p.minSubtotal)}` : null,
                    p.skus ? plural(JSON.parse(p.skus).length, 'SKU') : null,
                    p.customerId ? (
                      <Link to={`/customers/${p.customerId}`} className="text-link hover:underline">
                        {customers[p.customerId] ?? p.customerId}
                      </Link>
                    ) : null,
                    p.maxRedemptions ? plural(p.maxRedemptions, 'use') : null,
                    p.perCustomerLimit ? `${p.perCustomerLimit} per customer` : null,
                    p.validTo
                      ? `${state === 'ended' ? 'ended' : 'until'} ${dateTime(p.validTo, 'UTC')}`
                      : null,
                  ].filter(Boolean);
                  return (
                    <Tr key={p.id} className={cn(state !== 'active' && 'text-muted-foreground')}>
                      <Td>
                        <span className="font-mono">{p.code}</span>
                        {state !== 'active' ? (
                          <span className="ml-2 align-[0.0625em]">
                            <ToneBadge tone="idle" label={state === 'ended' ? 'Ended' : 'Paused'} />
                          </span>
                        ) : null}
                        {p.name ? (
                          <div className="text-muted-foreground text-xs">{p.name}</div>
                        ) : null}
                      </Td>
                      <Td label="Takes off">{describe(p)}</Td>
                      <Td label="Limits" className="text-muted-foreground text-xs">
                        {limits.length
                          ? limits.map((l, i) => (
                              // The limits keep a fixed order, so the index is a stable key.
                              <Fragment key={i}>
                                {i ? ' · ' : null}
                                {l}
                              </Fragment>
                            ))
                          : 'None'}
                      </Td>
                      <Td numeric label="Used">
                        {p.redeemed}
                      </Td>
                      <Td className="max-md:-ml-3 max-md:basis-full">
                        {state === 'ended' ? (
                          // Pausing or resuming it would change nothing, and its dates can't be
                          // edited: the way to run it again is a new code.
                          <p className="max-w-48 text-muted-foreground text-xs max-md:pl-3 md:text-right">
                            Ended, so it no longer applies.
                            {canOperate ? ' To run it again, add a new code.' : null}
                          </p>
                        ) : canOperate ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="status" />
                            <input type="hidden" name="id" value={p.id} />
                            <input
                              type="hidden"
                              name="status"
                              value={paused ? 'active' : 'paused'}
                            />
                            <Button
                              type="submit"
                              variant="ghost"
                              size="sm"
                              aria-label={`${paused ? 'Resume' : 'Pause'} ${p.code}`}
                            >
                              {paused ? 'Resume' : 'Pause'}
                            </Button>
                          </Form>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>No promotions yet.</Empty>
          )}
        </Section>
      </Body>
    </>
  );
}

/**
 * The fields of a new code: the code and what it takes off, then its limits, grouped. The action
 * checks them (`promotionFrom`).
 */
function NewPromotion({ error, busy }: { error?: string | null; busy: boolean }) {
  return (
    <Form method="post">
      <FieldGroup className="gap-5">
        {[
          ['code', 'Code', 'WELCOME15'],
          ['name', 'Name (optional)', 'Welcome offer'],
        ].map(([k, label, ph]) => (
          <Field key={k} className="gap-2">
            <FieldLabel htmlFor={`promo-${k}`}>{label}</FieldLabel>
            <Input id={`promo-${k}`} name={k} placeholder={ph} />
          </Field>
        ))}
        <div className="grid grid-cols-2 gap-3">
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-kind">Takes off</FieldLabel>
            <NativeSelect id="promo-kind" name="kind">
              <NativeSelectOption value="pct">A percentage</NativeSelectOption>
              <NativeSelectOption value="amount">An amount ({BASE_CURRENCY})</NativeSelectOption>
              <NativeSelectOption value="free_shipping">Shipping</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-value">Percent or amount</FieldLabel>
            <Input id="promo-value" name="value" inputMode="decimal" />
          </Field>
        </div>
        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0">
            Limits
          </FieldLegend>
          {[
            ['minSubtotal', `Minimum subtotal (${BASE_CURRENCY}, optional)`],
            ['skus', 'Only these SKUs (optional, comma separated)'],
            ['customerId', 'Only this customer id (optional)'],
            ['maxRedemptions', 'Uses in all (optional)'],
            ['perCustomerLimit', 'Uses per customer (optional)'],
          ].map(([k, label]) => (
            <Field key={k} className="gap-2">
              <FieldLabel htmlFor={`promo-${k}`}>{label}</FieldLabel>
              <Input id={`promo-${k}`} name={k} />
            </Field>
          ))}
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-validTo">Ends on (optional)</FieldLabel>
            <Input id="promo-validTo" name="validTo" type="date" className="max-w-48" />
          </Field>
        </FieldSet>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add promotion
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}
