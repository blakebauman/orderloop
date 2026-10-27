/**
 * One customer: the account as the commerce steps see it, and its tax exemption certificates.
 * Operators add a certificate (with its scan), verify it once checked with the issuer, and revoke
 * it; only a verified, unexpired certificate covering an order's ship-to exempts it from tax
 * (`commerce.tax`). Buyers never claim one.
 */

import { newId, taxCertificateState } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { ToneBadge } from '~/components/status';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { addCertificate, changeCertificate, customerById } from '~/lib/customers.server';
import { engine } from '~/lib/env.server';
import { dateTime, humanize, money } from '~/lib/format';
import { CERTIFICATE_STATES, expiryDay, placesLabel } from '~/lib/tax-certificates';
import { useCan } from '~/lib/use-me';
import { useNow } from '~/lib/use-now';
import type { Route } from './+types/customer';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.customer.name ?? 'Customer'} · Customers · OrderLoop` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const [customer, certificates] = await Promise.all([
    customerById(params.customerId),
    engine().taxCertificates(params.customerId),
  ]);
  if (!customer || !certificates) throw data('Customer not found', { status: 404 });
  const { stripeCustomerId: _c, stripePaymentMethodId: _pm, ...shown } = customer;
  // The next certificate's id, minted here so a form sent twice adds it once.
  return { customer: shown, certificates, nextId: newId('txc') };
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
  const { customer: c, certificates, nextId } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const canOperate = useCan('operator');
  const now = useNow(60_000);
  const business = c.kind === 'business';
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
      <Body className="grid gap-4">
        <Section title="Tax exemption certificates" flush>
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
                {certificates.map((t) => {
                  const state = taxCertificateState(t, now);
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
        {canOperate ? (
          <Section title="Add a certificate">
            {/* Keyed by the count, so the fields clear once a certificate is added (not on a refusal). */}
            <Form
              key={certificates.length}
              method="post"
              encType="multipart/form-data"
              className="grid max-w-xl gap-3 text-sm"
            >
              <input type="hidden" name="intent" value="add" />
              <input type="hidden" name="id" value={nextId} />
              <div className="grid gap-1">
                <label htmlFor="cert-number" className="caption">
                  Certificate number
                </label>
                <Input id="cert-number" name="number" required maxLength={64} className="h-8" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="cert-regions" className="caption">
                  Covers (a country, or a region of one: US, US-CA, CA-ON)
                </label>
                <Input
                  id="cert-regions"
                  name="regions"
                  required
                  autoCapitalize="characters"
                  autoCorrect="off"
                  placeholder="US-CA, US-NV"
                  className="h-8"
                />
              </div>
              <div className="grid gap-1">
                <label htmlFor="cert-expires" className="caption">
                  Last day it is valid (optional)
                </label>
                <Input id="cert-expires" name="expires" type="date" className="h-8 w-48" />
              </div>
              <div className="grid gap-1">
                <label htmlFor="cert-file" className="caption">
                  The certificate (PDF or image, up to 10 MB; optional)
                </label>
                <input
                  id="cert-file"
                  name="file"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  className="text-base"
                />
              </div>
              <p className="text-muted-foreground text-xs">
                It exempts orders once someone verifies it with the issuer.
              </p>
              {result && 'error' in result && result.intent === 'add' ? (
                <p role="alert" className="text-bad">
                  {result.error}
                </p>
              ) : null}
              <div>
                <Button type="submit" size="sm" disabled={busy}>
                  Add certificate
                </Button>
              </div>
            </Form>
          </Section>
        ) : null}
      </Body>
    </>
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
