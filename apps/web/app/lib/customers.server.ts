/**
 * A customer's page: the account as the Commerce page lists it, and its tax exemption certificates,
 * which the engine holds (`EngineRpc.taxCertificates`). A certificate's file is stored in the
 * documents bucket at `taxCertificateKey` by the web app before the engine adds the certificate,
 * as a cart's files are; one the engine doesn't end up holding is deleted again.
 */

import {
  attachmentName,
  isTaxCertificateId,
  type Principal,
  type RpcActor,
  TAX_CERTIFICATE_FILE_TYPES,
  type TaxCertificateFile,
  taxCertificateFileMatches,
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

type Done =
  | { ok: true; id: string; number: string; changed: boolean }
  | { ok: false; error: string };

/**
 * Adds the certificate the form describes, with its file if one was chosen. The form carries the
 * id its page minted, so sending it again (a double submit, a retry) finds the certificate already
 * there and changes nothing. A file is stored only for a customer that exists and a certificate
 * not yet added, and is deleted again unless the engine holds the certificate it belongs to.
 */
export async function addCertificate(
  customerId: string,
  me: Principal,
  f: FormData,
): Promise<Done> {
  const id = f.get('id');
  if (!isTaxCertificateId(id)) return { ok: false, error: 'Reload the page and add it again.' };
  const places = parseTaxPlaces(String(f.get('regions') ?? ''));
  if (typeof places === 'string') return { ok: false, error: places };
  const expiresAt = expiryFrom(String(f.get('expires') ?? ''));
  if (typeof expiresAt === 'string') return { ok: false, error: expiresAt };
  const upload = f.get('file');
  // A browser sends an empty file part when none was chosen.
  const chosen = upload instanceof File && upload.size > 0 ? upload : null;
  const bytes = chosen ? new Uint8Array(await chosen.arrayBuffer()) : null;
  if (chosen && bytes) {
    const problem = taxCertificateFileProblem(chosen);
    if (problem) return { ok: false, error: problem };
    if (!taxCertificateFileMatches(chosen.type, bytes.subarray(0, 16)))
      return { ok: false, error: `The file isn’t a ${TAX_CERTIFICATE_FILE_TYPES[chosen.type]}.` };
  }
  const held = await engine().taxCertificates(customerId);
  if (!held) return { ok: false, error: 'No such customer.' };
  const already = held.find((c) => c.id === id);
  if (already) return { ok: true, id, number: already.number, changed: false };

  let file: TaxCertificateFile | null = null;
  if (chosen && bytes) {
    file = {
      key: taxCertificateKey(customerId, id),
      name: attachmentName(chosen.name),
      type: chosen.type,
      size: chosen.size,
    };
    await docs().put(file.key, bytes, {
      httpMetadata: { contentType: chosen.type },
      customMetadata: { customerId, certificateId: id },
    });
  }
  let kept = false;
  try {
    const r = await engine().addTaxCertificate(
      customerId,
      { id, number: String(f.get('number') ?? ''), regions: places, expiresAt, file },
      await certificateActor(me, customerId),
    );
    kept = r.ok;
    return r.ok
      ? { ok: true, id, number: r.value.certificate.number, changed: r.value.changed }
      : r;
  } finally {
    // A call that threw may still have added it (the answer was lost): keep the file then.
    if (
      file &&
      !kept &&
      !(
        await engine()
          .taxCertificates(customerId)
          .catch(() => null)
      )?.some((c) => c.id === id)
    )
      await docs().delete(file.key);
  }
}

/** A certificate's file, if the customer holds that certificate and it has one. */
export async function certificateFile(customerId: string, id: string) {
  const c = (await engine().taxCertificates(customerId))?.find((x) => x.id === id);
  if (!c?.file || c.file.key !== taxCertificateKey(customerId, id)) return null;
  const obj = await docs().get(c.file.key);
  return obj ? { file: c.file, body: obj.body } : null;
}
