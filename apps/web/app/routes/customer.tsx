/**
 * One customer: the account as the commerce steps see it, and its tax exemption certificates.
 * Operators add a certificate (with its scan), verify it once checked with the issuer, and revoke
 * it; only a verified, unexpired certificate covering an order's ship-to exempts it from tax
 * (`commerce.tax`). Buyers never claim one.
 */

import { newId, ORDER_MODEL_LABELS, type OrderModel, taxCertificateState } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@orderloop/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { StatusBadge, ToneBadge } from '~/components/status';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { addCertificate, changeCertificate, customerById } from '~/lib/customers.server';
import { engine } from '~/lib/env.server';
import { count, dateTime, humanize, liveStatus, money, orderRef } from '~/lib/format';
import { countOrders, listOrders } from '~/lib/orders.server';
import { CERTIFICATE_STATES, expiryDay, placesLabel } from '~/lib/tax-certificates';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import type { Route } from './+types/customer';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.customer.name ?? 'Customer'} · Customers · OrderLoop` },
];

/** How many of the customer's orders the page lists, most recently changed first. */
const RECENT_ORDERS = 6;

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const [customer, certificates, recent, ordered] = await Promise.all([
    customerById(params.customerId),
    engine().taxCertificates(params.customerId),
    listOrders({ customer: params.customerId, sort: 'updated' }, RECENT_ORDERS),
    countOrders({ customer: params.customerId }),
  ]);
  if (!customer || !certificates) throw data('Customer not found', { status: 404 });
  const { stripeCustomerId: _c, stripePaymentMethodId: _pm, ...shown } = customer;
  return {
    customer: shown,
    certificates,
    // An open order with no run reads "recorded", never waiting (`liveStatus`).
    recent: recent.map((o) => ({ ...o, status: liveStatus(o) })),
    ordered,
    // The next certificate's id, minted here so a form sent twice adds it once.
    nextId: newId('txc'),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const customerId = params.customerId;
  const f = await request.formData();
  const intent = f.get('intent');
  const r =
    intent === 'verify' || intent === 'revoke'
      ? await changeCertificate(customerId, String(f.get('id') ?? ''), intent, me)
      : await addCertificate(customerId, me, f);
  if (!r.ok) return { intent: String(intent ?? 'add'), error: r.error };
  // A repeat (a form sent twice, verifying what's verified) did nothing to record.
  if (r.changed)
    await audit(
      request,
      intent === 'verify'
        ? 'tax_certificate.verified'
        : intent === 'revoke'
          ? 'tax_certificate.revoked'
          : 'tax_certificate.added',
      { actor: me, target: customerId, detail: { certificate: r.id, via: 'app' } },
    );
  return { intent: String(intent ?? 'add'), ok: true as const };
}

export default function CustomerPage() {
  const { customer: c, certificates, recent, ordered, nextId } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const canOperate = useCan('operator');
  const now = useNow(60_000);
  const business = c.kind === 'business';
  // A certificate added closes the form; a refusal keeps it open with what was typed.
  const sheet = useFormSheet(result, (r) => 'ok' in r && r.intent === 'add');
  const addError =
    sheet.result && 'error' in sheet.result && sheet.result.intent === 'add'
      ? sheet.result.error
      : null;
  const states = certificates.map((t) => taxCertificateState(t, now));
  const exempting = states.filter((s) => s === 'active').length;
  const over = business && !!c.creditLimit && c.balance > c.creditLimit;
  // Close enough that one more order could tip it over, as Commerce's customer list marks it.
  const near = business && !over && !!c.creditLimit && c.balance >= c.creditLimit * 0.9;
  const figures: Figure[] = [
    ...(business
      ? [
          {
            label: 'Balance',
            value: money(c.balance),
            note: over ? 'Over limit' : near ? 'Near limit' : undefined,
            tone: over ? 'text-bad' : near ? 'text-wait' : undefined,
          },
          { label: 'Credit limit', value: c.creditLimit ? money(c.creditLimit) : 'No limit' },
        ]
      : []),
    { label: 'Terms', value: business ? humanize(c.terms) : 'Pays at checkout' },
    {
      label: 'Exempting certificates',
      value: count(exempting),
      note: `of ${count(certificates.length)} on file`,
    },
  ];
  return (
    <>
      <PageHeader
        title={c.name}
        crumbs={
          <Link to="/commerce#customers" className="hover:underline">
            Customers
          </Link>
        }
        subtitle={[
          humanize(c.kind),
          business ? `${humanize(c.tier)} tier` : null,
          business ? humanize(c.terms) : 'Pays at checkout',
          business && c.creditLimit
            ? `${money(c.balance)} of ${money(c.creditLimit)} credit`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={`/orders?q=${encodeURIComponent(c.name)}`}>Orders</Link>
          </Button>
        }
      />
      <Body className="grid gap-4 lg:gap-6">
        {/* The account as the commerce steps read it, figure by figure (the preview cards' tiles). */}
        <section
          aria-label="Account"
          className={cn('grid grid-cols-2 gap-4', business && 'lg:grid-cols-4')}
        >
          {figures.map((f) => (
            <FigureCard key={f.label} f={f} />
          ))}
        </section>
        <Section
          title="Tax exemption certificates"
          description="Only a verified, unexpired certificate covering an order’s ship-to exempts it from tax."
          flush
          actions={
            canOperate ? (
              <FormSheet
                open={sheet.open}
                onOpenChange={sheet.onOpenChange}
                label="Add certificate"
                title="Add a certificate"
                description="It exempts orders once someone verifies it with the issuer."
              >
                <AddCertificate nextId={nextId} error={addError} busy={busy} />
              </FormSheet>
            ) : null
          }
        >
          {certificates.length ? (
            <Table stack="cards" caption="Tax exemption certificates">
              <TableHead>
                <Tr>
                  <Th>Certificate</Th>
                  <Th>Covers</Th>
                  <Th>Expires</Th>
                  <Th>Status</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </Tr>
              </TableHead>
              <TableBody>
                {certificates.map((t, i) => {
                  const state = states[i] ?? taxCertificateState(t, now);
                  const shown = CERTIFICATE_STATES[state];
                  return (
                    <Tr key={t.id} className={cn(state === 'revoked' && 'text-muted-foreground')}>
                      <Td>
                        <span className="font-mono">{t.number}</span>
                        {t.file ? (
                          <a
                            href={`/customers/${c.id}/tax-certificates/${t.id}`}
                            className="block truncate text-link text-xs hover:underline"
                            download={t.file.name}
                          >
                            {t.file.name}
                          </a>
                        ) : (
                          <div className="text-muted-foreground text-xs">No file</div>
                        )}
                      </Td>
                      <Td label="Covers">{placesLabel(t.regions)}</Td>
                      <Td label="Expires">
                        {t.expiresAt ? (
                          expiryDay(t.expiresAt)
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </Td>
                      <Td label="Status">
                        <ToneBadge tone={shown.tone} label={shown.label} />
                        <div className="text-muted-foreground text-xs">
                          {t.revokedAt
                            ? `Revoked by ${t.revokedBy} · ${dateTime(t.revokedAt, 'UTC')}`
                            : t.verifiedAt
                              ? `Verified by ${t.verifiedBy} · ${dateTime(t.verifiedAt, 'UTC')}`
                              : `Added by ${t.createdBy} · ${dateTime(t.createdAt, 'UTC')}`}
                        </div>
                      </Td>
                      <Td className="max-md:-ml-3 max-md:basis-full">
                        {canOperate && t.status === 'active' ? (
                          <div className="flex gap-1">
                            {state === 'unverified' ? (
                              <CertificateButton id={t.id} intent="verify" number={t.number} />
                            ) : null}
                            <CertificateButton id={t.id} intent="revoke" number={t.number} />
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>No certificates. Orders for this customer are taxed.</Empty>
          )}
          {result && 'error' in result && result.intent !== 'add' ? (
            <p role="alert" className="px-4 py-2 text-bad text-sm">
              {result.error}
            </p>
          ) : null}
        </Section>
        <Section
          title="Recent orders"
          description={
            ordered.n
              ? `The ${Math.min(recent.length, ordered.n)} most recently changed of ${ordered.more ? `${count(ordered.n)}+` : count(ordered.n)} orders.`
              : undefined
          }
          actions={
            ordered.n > recent.length ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`/orders?q=${encodeURIComponent(c.name)}`}>All orders</Link>
              </Button>
            ) : undefined
          }
        >
          {recent.length ? (
            <ul className="-mx-2 flex flex-col gap-0.5">
              {recent.map((o) => (
                <OrderItem key={o.id} o={o} />
              ))}
            </ul>
          ) : (
            <Empty>No orders yet.</Empty>
          )}
        </Section>
      </Body>
    </>
  );
}

/** One of the customer's orders: where it is, linked to its page, with its total and last change. */
function OrderItem({
  o,
}: {
  o: ReturnType<typeof useLoaderData<typeof loader>>['recent'][number];
}) {
  const model = ORDER_MODEL_LABELS[o.model as OrderModel] ?? o.model;
  return (
    <Item asChild size="xs" className="relative items-start px-2 hover:bg-muted/60">
      <li>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <Link
              to={`/orders/${o.id}`}
              className="truncate after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
            >
              {o.title || o.externalId || model}{' '}
              <span className="font-mono font-normal text-muted-foreground text-xs">
                {orderRef(o.id)}
              </span>
            </Link>
          </ItemTitle>
          <ItemDescription className="text-xs">
            {model}
            {o.waitingAt && o.status === 'waiting' ? ` · waiting at ${o.waitingAt}` : ''}
            {o.stoppedAt && o.status !== 'completed' ? ` · stopped at ${o.stoppedAt}` : ''}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="flex-col items-end gap-1 self-start">
          <span className="font-medium text-sm tabular">{money(o.total, o.currency)}</span>
          <StatusBadge status={o.status} />
        </ItemActions>
      </li>
    </Item>
  );
}

type Figure = { label: string; value: string; note?: string; tone?: string };

/** One account figure: its label, the value set large, and a muted note under it. */
function FigureCard({ f }: { f: Figure }) {
  return (
    <Card size="sm" className="min-w-0 gap-1">
      <CardContent className="flex flex-1 flex-col gap-1">
        <CardDescription>{f.label}</CardDescription>
        <CardTitle className={cn('font-semibold text-2xl tabular max-md:text-xl', f.tone)}>
          {f.value}
        </CardTitle>
        {f.note ? (
          <CardDescription className={cn('text-xs tabular', f.tone && 'font-medium', f.tone)}>
            {f.note}
          </CardDescription>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CertificateButton({
  id,
  intent,
  number,
}: {
  id: string;
  intent: 'verify' | 'revoke';
  number: string;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        aria-label={`${intent === 'verify' ? 'Verify' : 'Revoke'} certificate ${number}`}
      >
        {intent === 'verify' ? 'Verify' : 'Revoke'}
      </Button>
    </Form>
  );
}

/** A new certificate's fields; the id is minted by the loader, so a form sent twice adds it once. */
function AddCertificate({
  nextId,
  error,
  busy,
}: {
  nextId: string;
  error?: string | null;
  busy: boolean;
}) {
  return (
    <Form method="post" encType="multipart/form-data">
      <input type="hidden" name="intent" value="add" />
      <input type="hidden" name="id" value={nextId} />
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-number">Certificate number</FieldLabel>
          <Input id="cert-number" name="number" required maxLength={64} />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-regions">Covers</FieldLabel>
          <Input
            id="cert-regions"
            name="regions"
            required
            autoCapitalize="characters"
            autoCorrect="off"
            placeholder="US-CA, US-NV"
            aria-describedby="cert-regions-hint"
          />
          <FieldDescription id="cert-regions-hint">
            A country, or a region of one: US, US-CA, CA-ON.
          </FieldDescription>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-expires">Last day it is valid (optional)</FieldLabel>
          <Input id="cert-expires" name="expires" type="date" className="max-w-48" />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-file">The certificate (optional)</FieldLabel>
          <Input
            id="cert-file"
            name="file"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            aria-describedby="cert-file-hint"
          />
          <FieldDescription id="cert-file-hint">PDF or image, up to 10 MB.</FieldDescription>
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add certificate
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}
