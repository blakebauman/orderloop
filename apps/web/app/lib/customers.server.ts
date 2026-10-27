/**
 * A customer's page: the account as the Commerce page lists it, and its tax exemption certificates,
 * which the engine holds (`EngineRpc.taxCertificates`). A certificate's file is stored in the
 * documents bucket at `taxCertificateKey` by the web app before the engine adds the certificate,
 * as a cart's files are; one the engine refuses is deleted again.
 */

import {
  attachmentName,
  newId,
  type Principal,
  type RpcActor,
  type TaxCertificateFile,
  taxCertificateFileProblem,
  taxCertificateKey,
} from '@orderloop/core';
import { customers } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { actorName } from './audit.server';
import { db, docs, engine } from './env.server';
import { signedActor } from './principal.server';
import { expiryFrom, parseTaxPlaces } from './tax-certificates';

export async function customerById(id: string) {
  return (await db().select().from(customers).where(eq(customers.id, id)).get()) ?? null;
}

/** The engine call's actor: the person, signed for this customer's certificates alone. */
const certificateActor = (me: Principal, customerId: string) =>
  signedActor(
    { kind: 'staff', id: me.id, name: actorName(me), role: me.role } satisfies RpcActor,
    `tax-certificates:${customerId}`,
  );

type Done = { ok: true; id: string; number: string } | { ok: false; error: string };

/** Adds the certificate the form describes, with its file if one was chosen. */
export async function addCertificate(
  customerId: string,
  me: Principal,
  f: FormData,
): Promise<Done> {
  const places = parseTaxPlaces(String(f.get('regions') ?? ''));
  if (typeof places === 'string') return { ok: false, error: places };
  const expiresAt = expiryFrom(String(f.get('expires') ?? ''));
  if (typeof expiresAt === 'string') return { ok: false, error: expiresAt };
  const upload = f.get('file');
  // A browser sends an empty file part when none was chosen.
  const chosen = upload instanceof File && upload.size > 0 ? upload : null;
  if (chosen) {
    const problem = taxCertificateFileProblem(chosen);
    if (problem) return { ok: false, error: problem };
  }
  const id = newId('txc');
  let file: TaxCertificateFile | null = null;
  if (chosen) {
    file = {
      key: taxCertificateKey(customerId, id),
      name: attachmentName(chosen.name),
      type: chosen.type,
      size: chosen.size,
    };
    await docs().put(file.key, await chosen.arrayBuffer(), {
      httpMetadata: { contentType: chosen.type },
      customMetadata: { customerId, certificateId: id },
    });
  }
  const r = await engine().addTaxCertificate(
    customerId,
    { id, number: String(f.get('number') ?? ''), regions: places, expiresAt, file },
    await certificateActor(me, customerId),
  );
  if (!r.ok) {
    if (file) await docs().delete(file.key);
    return r;
  }
  return { ok: true, id, number: r.value.number };
}

/** Verifies or revokes one certificate. */
export async function changeCertificate(
  customerId: string,
  id: string,
  change: 'verify' | 'revoke',
  me: Principal,
): Promise<Done> {
  const actor = await certificateActor(me, customerId);
  const r =
    change === 'verify'
      ? await engine().verifyTaxCertificate(customerId, id, actor)
      : await engine().revokeTaxCertificate(customerId, id, actor);
  return r.ok ? { ok: true, id, number: r.value.number } : r;
}

/** A certificate's file, if the customer holds that certificate and it has one. */
export async function certificateFile(customerId: string, id: string) {
  const c = (await engine().taxCertificates(customerId))?.find((x) => x.id === id);
  if (!c?.file || c.file.key !== taxCertificateKey(customerId, id)) return null;
  const obj = await docs().get(c.file.key);
  return obj ? { file: c.file, body: obj.body } : null;
}
