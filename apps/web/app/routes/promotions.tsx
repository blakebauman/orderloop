/**
 * Promotion codes: what each takes off, its limits and how often it has been used. Codes reach an
 * order from a cart (or `meta.promoCodes`); a flow applies them with an Apply promotions step.
 */

import { BASE_CURRENCY } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { ToneBadge } from '~/components/status';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { dateTime, money } from '~/lib/format';
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
  return { promotions: await listPromotions() };
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
  const { promotions } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const canOperate = useCan('operator');
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
      />
      <Body className="grid gap-4">
        <Section title="Codes" flush>
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
                  return (
                    <Tr key={p.id} className={cn(paused && 'text-muted-foreground')}>
                      <Td>
                        <span className="font-mono">{p.code}</span>
                        {paused ? (
                          <span className="ml-2 align-[0.0625em]">
                            <ToneBadge tone="idle" label="Paused" />
                          </span>
                        ) : null}
                        {p.name ? (
                          <div className="text-muted-foreground text-xs">{p.name}</div>
                        ) : null}
                      </Td>
                      <Td label="Takes off">{describe(p)}</Td>
                      <Td label="Limits" className="text-muted-foreground text-xs">
                        {[
                          p.minSubtotal ? `over ${money(p.minSubtotal)}` : null,
                          p.skus ? `${JSON.parse(p.skus).length} SKUs` : null,
                          p.customerId ? `customer ${p.customerId}` : null,
                          p.maxRedemptions ? `${p.maxRedemptions} uses` : null,
                          p.perCustomerLimit ? `${p.perCustomerLimit} per customer` : null,
                          p.validTo ? `until ${dateTime(p.validTo, 'UTC')}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'None'}
                      </Td>
                      <Td numeric label="Used">
                        {p.redeemed}
                      </Td>
                      <Td className="max-md:-ml-3 max-md:basis-full">
                        {canOperate ? (
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
        {canOperate ? (
          <Section title="New promotion">
            <Form method="post" className="grid max-w-xl gap-3 text-sm">
              {[
                ['code', 'Code', 'WELCOME15'],
                ['name', 'Name (optional)', 'Welcome offer'],
              ].map(([k, label, ph]) => (
                <div key={k} className="grid gap-1">
                  <label htmlFor={`promo-${k}`} className="caption">
                    {label}
                  </label>
                  <Input id={`promo-${k}`} name={k} placeholder={ph} className="h-8" />
                </div>
              ))}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <label htmlFor="promo-kind" className="caption">
                    Takes off
                  </label>
                  <NativeSelect id="promo-kind" name="kind" className="h-8">
                    <NativeSelectOption value="pct">A percentage</NativeSelectOption>
                    <NativeSelectOption value="amount">
                      An amount ({BASE_CURRENCY})
                    </NativeSelectOption>
                    <NativeSelectOption value="free_shipping">Shipping</NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="grid gap-1">
                  <label htmlFor="promo-value" className="caption">
                    Percent or amount
                  </label>
                  <Input id="promo-value" name="value" inputMode="decimal" className="h-8" />
                </div>
              </div>
              {[
                ['minSubtotal', `Minimum subtotal (${BASE_CURRENCY}, optional)`],
                ['skus', 'Only these SKUs (optional, comma separated)'],
                ['customerId', 'Only this customer id (optional)'],
                ['maxRedemptions', 'Uses in all (optional)'],
                ['perCustomerLimit', 'Uses per customer (optional)'],
              ].map(([k, label]) => (
                <div key={k} className="grid gap-1">
                  <label htmlFor={`promo-${k}`} className="caption">
                    {label}
                  </label>
                  <Input id={`promo-${k}`} name={k} className="h-8" />
                </div>
              ))}
              <div className="grid gap-1">
                <label htmlFor="promo-validTo" className="caption">
                  Ends on (optional)
                </label>
                <Input id="promo-validTo" name="validTo" type="date" className="h-8 w-48" />
              </div>
              {result && 'error' in result ? (
                <p role="alert" className="text-bad">
                  {result.error}
                </p>
              ) : null}
              <div>
                <Button type="submit" size="sm" disabled={busy}>
                  Add promotion
                </Button>
              </div>
            </Form>
          </Section>
        ) : null}
      </Body>
    </>
  );
}
