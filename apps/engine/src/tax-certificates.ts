/**
 * Customers' tax exemption certificates (`tax-exemption.ts` in core): what staff add, verify and
 * revoke through `EngineRpc`, and what `commerce.tax` reads inside its step. The web app stores a
 * certificate's file before adding it; erasing the customer deletes both (`subjects.ts`).
 */

import {
  checkTaxCertificateInput,
  MAX_TAX_CERTIFICATES,
  type Refusable,
  type RpcActor,
  type TaxCertificate,
  type TaxPlace,
} from '@orderloop/core';
import { createDb, customers, taxCertificates } from '@orderloop/db';
import { and, asc, count, eq } from 'drizzle-orm';

type Row = typeof taxCertificates.$inferSelect;

function certificateOf(r: Row): TaxCertificate {
  return {
    id: r.id,
    customerId: r.customerId,
    number: r.number,
    regions: JSON.parse(r.regions) as TaxPlace[],
    expiresAt: r.expiresAt,
    file:
      r.fileKey && r.fileName && r.fileType && r.fileSize !== null
        ? { key: r.fileKey, name: r.fileName, type: r.fileType, size: r.fileSize }
        : null,
    status: r.status === 'revoked' ? 'revoked' : 'active',
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    verifiedBy: r.verifiedBy,
    verifiedAt: r.verifiedAt,
    revokedBy: r.revokedBy,
    revokedAt: r.revokedAt,
  };
}

/**
 * A customer's certificates, oldest first (the order `exemptingCertificate` picks from, so a
 * replayed step picks the same one). Empty for no customer.
 */
export async function customerTaxCertificates(
  env: Env,
  customerId: string | undefined,
): Promise<TaxCertificate[]> {
  if (!customerId) return [];
  const rows = await createDb(env.DB)
    .select()
    .from(taxCertificates)
    .where(eq(taxCertificates.customerId, customerId))
    .orderBy(asc(taxCertificates.createdAt), asc(taxCertificates.id));
  return rows.map(certificateOf);
}

async function customerExists(env: Env, customerId: string) {
  return !!(await createDb(env.DB)
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, customerId))
    .get());
}

/** As `EngineRpc.taxCertificates`: null for an id no customer has. */
export async function listTaxCertificates(env: Env, customerId: string) {
  if (!(await customerExists(env, customerId))) return null;
  return customerTaxCertificates(env, customerId);
}

const refuse = (error: string) => ({ ok: false as const, error });

async function find(env: Env, customerId: string, id: string) {
  const row = await createDb(env.DB)
    .select()
    .from(taxCertificates)
    .where(and(eq(taxCertificates.id, id), eq(taxCertificates.customerId, customerId)))
    .get();
  return row ? certificateOf(row) : null;
}

/**
 * Adds a certificate, unverified. Adding the same id again (a retried request) answers with the
 * one already there rather than a second.
 */
export async function addTaxCertificate(
  env: Env,
  customerId: string,
  raw: unknown,
  actor: RpcActor,
  now = Date.now(),
): Promise<Refusable<TaxCertificate>> {
  if (!(await customerExists(env, customerId))) return refuse('No such customer.');
  const checked = checkTaxCertificateInput(customerId, raw);
  if (!checked.ok) return checked;
  const c = checked.value;
  const db = createDb(env.DB);
  const already = await find(env, customerId, c.id);
  if (already) return { ok: true, value: already };
  const held = await db
    .select({ n: count() })
    .from(taxCertificates)
    .where(eq(taxCertificates.customerId, customerId))
    .get();
  if ((held?.n ?? 0) >= MAX_TAX_CERTIFICATES)
    return refuse(`A customer holds at most ${MAX_TAX_CERTIFICATES} certificates.`);
  await db
    .insert(taxCertificates)
    .values({
      id: c.id,
      customerId,
      number: c.number,
      regions: JSON.stringify(c.regions),
      expiresAt: c.expiresAt,
      fileKey: c.file?.key ?? null,
      fileName: c.file?.name ?? null,
      fileType: c.file?.type ?? null,
      fileSize: c.file?.size ?? null,
      status: 'active',
      createdBy: actor.name,
      createdAt: now,
    })
    .onConflictDoNothing();
  const added = await find(env, customerId, c.id);
  return added ? { ok: true, value: added } : refuse('That certificate id is taken.');
}

/** Marks an active, unexpired certificate verified by `actor`. Verifying it again changes nothing. */
export async function verifyTaxCertificate(
  env: Env,
  customerId: string,
  id: string,
  actor: RpcActor,
  now = Date.now(),
): Promise<Refusable<TaxCertificate>> {
  const c = await find(env, customerId, id);
  if (!c) return refuse('No such certificate.');
  if (c.status === 'revoked') return refuse('The certificate was revoked; add a new one.');
  if (c.verifiedAt !== null) return { ok: true, value: c };
  if (c.expiresAt !== null && now > c.expiresAt)
    return refuse('The certificate has expired; add the renewed one.');
  await createDb(env.DB)
    .update(taxCertificates)
    .set({ verifiedBy: actor.name, verifiedAt: now })
    .where(and(eq(taxCertificates.id, id), eq(taxCertificates.customerId, customerId)));
  return { ok: true, value: { ...c, verifiedBy: actor.name, verifiedAt: now } };
}

/** Revokes a certificate, keeping it. Revoking it again changes nothing. */
export async function revokeTaxCertificate(
  env: Env,
  customerId: string,
  id: string,
  actor: RpcActor,
  now = Date.now(),
): Promise<Refusable<TaxCertificate>> {
  const c = await find(env, customerId, id);
  if (!c) return refuse('No such certificate.');
  if (c.status === 'revoked') return { ok: true, value: c };
  await createDb(env.DB)
    .update(taxCertificates)
    .set({ status: 'revoked', revokedBy: actor.name, revokedAt: now })
    .where(and(eq(taxCertificates.id, id), eq(taxCertificates.customerId, customerId)));
  return {
    ok: true,
    value: { ...c, status: 'revoked', revokedBy: actor.name, revokedAt: now },
  };
}
