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
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from 'react-router';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { ToneBadge } from '~/components/status';
import { useAssistant } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { dateTime, money, plural } from '~/lib/format';
import { customerNames } from '~/lib/orders.server';
import { promotionState } from '~/lib/promotions';
import { listPromotions, promotionFrom } from '~/lib/promotions.server';
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
  await requireUser(request, 'operator');
  // Checked here; the page then adds it through the assistant (`create_promotion`), whose card
  // says what the code does, and the person confirms it there.
  const p = promotionFrom(await request.formData());
  if (typeof p === 'string') return { error: p };
  const { customerId, minSubtotal, skus, validTo, maxRedemptions, perCustomerLimit, ...rest } = p;
  return {
    create: {
      ...rest,
      ...(customerId ? { customerId } : {}),
      ...(minSubtotal !== null ? { minSubtotal } : {}),
      ...(skus ? { skus } : {}),
      ...(validTo !== null ? { validTo } : {}),
      ...(maxRedemptions !== null ? { maxRedemptions } : {}),
      ...(perCustomerLimit !== null ? { perCustomerLimit } : {}),
    },
  };
}

const describe = (p: { kind: string; value: number; currency: string | null }) =>
  p.kind === 'pct'
    ? `${p.value}% off`
    : p.kind === 'amount'
      ? `${money(p.value, p.currency ?? BASE_CURRENCY)} off`
      : 'Free shipping';

export default function Promotions() {
  const { promotions, customers, now } = useLoaderData<typeof loader>();
  const answer = useActionData<typeof action>();
  const nav = useNavigation();
  const canOperate = useCan('operator');
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  // A checked form is added through the assistant; its answer closes the form or says why not.
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: true } | { error: string } | null>(null);
  const create = answer && 'create' in answer ? answer.create : undefined;
  useEffect(() => {
    if (!create) return;
    let live = true;
    setAsking(true);
    setOutcome(null);
    act('create_promotion', create)
      .then((r) => {
        if (!live || 'declined' in r) return;
        setOutcome({ ok: true });
        revalidate();
      })
      .catch(
        (e: unknown) => live && setOutcome({ error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => live && setAsking(false));
    return () => {
      live = false;
    };
  }, [create]);
  const result = outcome ?? (answer && 'error' in answer ? answer : undefined);
  const busy = nav.state === 'submitting' || asking;
  // A code added closes the form; a refusal keeps it open with what was typed.
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
                          <StatusButton id={p.id} code={p.code} paused={paused} />
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

/** Pauses or resumes a code through the assistant: its card says what changes for buyers. */
function StatusButton({ id, code, paused }: { id: string; code: string; paused: boolean }) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act('set_promotion_status', {
        promotionId: id,
        status: paused ? 'active' : 'paused',
      });
      if (!('declined' in r)) revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={`${paused ? 'Resume' : 'Pause'} ${code}`}
        onClick={() => void run()}
      >
        {busy ? 'Confirm it in the assistant' : paused ? 'Resume' : 'Pause'}
      </Button>
      {error ? (
        <span role="alert" className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}
