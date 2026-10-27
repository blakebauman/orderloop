/**
 * Tax exemption certificates: a business customer's proof (a resale or exempt-organization
 * certificate, say) that it pays no sales tax in the places the certificate covers. Staff add,
 * verify and revoke them on the customer's page; a buyer never claims one. `commerce.tax` charges
 * no tax on an order whose customer holds one that is in force where the order ships
 * (`exemptingCertificate`), or hands it to the tax provider to decide. Everything is judged as of
 * the order's start (the run's `now`): a certificate verified, revoked or expiring after the order
 * was placed doesn't change that order.
 */

import { z } from 'zod';
import { regionCodes } from './address';
import { type TaxPlace, taxPlaceSchema } from './shipping';

export const TAX_CERTIFICATE_STATUSES = ['active', 'revoked'] as const;
export type TaxCertificateStatus = (typeof TAX_CERTIFICATE_STATUSES)[number];

/** A certificate's scan, in the documents bucket at `taxCertificateKey`. */
export type TaxCertificateFile = { key: string; name: string; type: string; size: number };

export type TaxCertificate = {
  id: string;
  customerId: string;
  /** The number printed on the certificate, as the issuing authority wrote it. */
  number: string;
  /** Where it exempts: a whole country, or a region within one. */
  regions: TaxPlace[];
  /** The end of its last day (ms, UTC), or null when it doesn't expire. */
  expiresAt: number | null;
  file: TaxCertificateFile | null;
  /** Revoking keeps the row, for the record of which orders it exempted. */
  status: TaxCertificateStatus;
  /** Who added it, as the record names them, and their principal id (for separation of duties). */
  createdBy: string;
  createdById: string;
  createdAt: number;
  /** Who checked it against the issuing authority; unverified exempts nothing. */
  verifiedBy: string | null;
  verifiedAt: number | null;
  revokedBy: string | null;
  revokedAt: number | null;
};

/** A change staff asked for, and whether it changed anything (a repeat doesn't, and isn't audited). */
export type TaxCertificateChange = { certificate: TaxCertificate; changed: boolean };

/** What staff give to add one; the engine sets who and when. */
export type TaxCertificateInput = {
  id: string;
  number: string;
  regions: TaxPlace[];
  expiresAt: number | null;
  file: TaxCertificateFile | null;
};

/** Certificates one customer may hold, revoked ones included. */
export const MAX_TAX_CERTIFICATES = 100;
export const MAX_TAX_CERTIFICATE_BYTES = 10 * 1024 * 1024;

/** The file types a certificate is kept as: a scan or a PDF. Nothing that a browser would run. */
export const TAX_CERTIFICATE_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
};

/** Where a certificate's file lives in the documents bucket, beside `orders/` and `carts/`. */
export const taxCertificateKey = (customerId: string, id: string) =>
  `${taxCertificatePrefix(customerId)}${id}`;

/** Every certificate file a customer has, as a bucket prefix (what erasure deletes). */
export const taxCertificatePrefix = (customerId: string) =>
  `customers/${customerId}/tax-certificates/`;

/** A certificate id as the web app mints it (`newId('txc')`), safe in a bucket key. */
export const isTaxCertificateId = (id: unknown): id is string =>
  typeof id === 'string' && /^txc_[a-z0-9]{1,40}$/.test(id);

/** The first bytes each certificate file type starts with. */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'application/pdf': (b) => ascii(b, 0, '%PDF-'),
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
};

const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/**
 * True when a file's first bytes are what its declared type starts with, so a page or script
 * renamed `.pdf` isn't stored as a certificate.
 */
export const taxCertificateFileMatches = (type: string, head: Uint8Array) =>
  SIGNATURES[type]?.(head) ?? false;

/** Why a file can't be a certificate's, or null. */
export function taxCertificateFileProblem(f: { type: string; size: number }): string | null {
  if (!(f.type in TAX_CERTIFICATE_FILE_TYPES)) return 'Attach a PDF or an image (PNG, JPEG, WebP).';
  if (f.size <= 0) return 'The file is empty.';
  if (f.size > MAX_TAX_CERTIFICATE_BYTES) return 'A file is at most 10 MB.';
  return null;
}

/** Printable, one line: it reaches the timeline, the order's output and a provider's request. */
const certificateNumberSchema = z
  .string()
  .trim()
  .min(1, 'The certificate number is required.')
  .max(64, 'A certificate number is at most 64 characters.')
  .regex(/^[A-Za-z0-9 ./#-]+$/, 'A certificate number is letters, digits, spaces and . / # -');

export const taxCertificateInputSchema = z.object({
  id: z.string().refine(isTaxCertificateId, 'Not a certificate id.'),
  number: certificateNumberSchema,
  regions: z
    .array(taxPlaceSchema)
    .min(1, 'Name at least one country or region it covers.')
    .max(100, 'A certificate covers at most 100 places.'),
  expiresAt: z.number().int().positive().nullable(),
  file: z
    .object({
      key: z.string().min(1).max(200),
      name: z.string().min(1).max(120),
      type: z.string(),
      size: z.number().int(),
    })
    .nullable(),
});

/**
 * The certificate as the engine stores it, or why not: its fields check out, and its file (if
 * any) is where the web app stores this customer's certificate files.
 */
export function checkTaxCertificateInput(
  customerId: string,
  raw: unknown,
): { ok: true; value: TaxCertificateInput } | { ok: false; error: string } {
  const r = taxCertificateInputSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'Invalid certificate.' };
  const c = r.data;
  if (c.file) {
    if (c.file.key !== taxCertificateKey(customerId, c.id))
      return { ok: false, error: 'The file is not this certificate’s.' };
    const problem = taxCertificateFileProblem(c.file);
    if (problem) return { ok: false, error: problem };
  }
  const regions = c.regions.map((p) => ({
    country: p.country,
    ...(p.region ? { region: p.region.toUpperCase() } : {}),
  }));
  // A country whose addresses name a region (US, CA, AU) takes only one of its regions, so a
  // certificate for "US-CAL" can't sit there matching nothing.
  const unknown = regions.find((p) => {
    const codes = p.region ? regionCodes(p.country) : null;
    return !!codes && !codes.includes(p.region!);
  });
  if (unknown)
    return {
      ok: false,
      error: `${unknown.country}-${unknown.region} isn’t a region of ${unknown.country}.`,
    };
  return { ok: true, value: { ...c, regions } };
}

/**
 * True when `places` cover a sale to `country` and `region`: a place naming the country with no
 * region, or that region of it. Without a country nothing is covered; without a region, only a
 * whole country.
 */
export function coversPlace(
  places: readonly TaxPlace[],
  country: string | undefined,
  region: string | undefined,
): boolean {
  if (!country) return false;
  const r = region?.trim().toUpperCase();
  return places.some(
    (p) => p.country === country && (!p.region || (!!r && p.region.toUpperCase() === r)),
  );
}

export type TaxCertificateState = 'active' | 'unverified' | 'expired' | 'revoked';

/**
 * Whether a certificate was in force at `now`, and if not, why not. Revoking and verifying count
 * from when they happened: one revoked after `now` was still in force then, and one verified after
 * it wasn't yet.
 */
export function taxCertificateState(
  c: Pick<TaxCertificate, 'status' | 'verifiedAt' | 'expiresAt' | 'revokedAt'>,
  now: number,
): TaxCertificateState {
  if (c.status === 'revoked' && (c.revokedAt === null || c.revokedAt <= now)) return 'revoked';
  if (c.expiresAt !== null && now > c.expiresAt) return 'expired';
  if (c.verifiedAt === null || c.verifiedAt > now) return 'unverified';
  return 'active';
}

/**
 * The certificate that exempts a sale to `country` and `region` placed at `now`: verified, not
 * revoked and unexpired then, and covering the place. The first in `certs`' order (oldest first).
 * Null when none does.
 */
export function exemptingCertificate<
  C extends Pick<TaxCertificate, 'status' | 'verifiedAt' | 'expiresAt' | 'revokedAt' | 'regions'>,
>(certs: readonly C[], country: string | undefined, region: string | undefined, now: number) {
  return (
    certs.find(
      (c) => taxCertificateState(c, now) === 'active' && coversPlace(c.regions, country, region),
    ) ?? null
  );
}

/**
 * What a tax provider is told of a certificate that exempts the order: where it applies, and its
 * number only for a provider that may have buyer details (`providerRequest`).
 */
export type TaxExemption = { certificate?: string; regions: TaxPlace[] };

/**
 * What a cart's quote says when a certificate exempted it: "Tax exempt (certificate RS-1234)". An
 * order's step says "certificate on file" instead: the number names the business, and an order
 * keeps its steps' summaries long after a customer may be erased.
 */
export const taxExemptNote = (c: { number?: string }) =>
  `Tax exempt (certificate ${c.number ?? 'on file'})`;

/**
 * Where `meta[CUSTOMER_MATCHED_BY]` says an order's customer was guessed rather than named by a
 * trusted caller: `email` (a storefront order whose buyer email matched the account),
 * `unauthenticated_email` (email intake from the account's address with the sender check off) or
 * `name` (a name read from a document). Anyone can type an email or a company name, or send as an
 * address nothing checks, so such an order gets none of the customer's exemptions.
 */
export const CUSTOMER_MATCHED_BY = 'customerMatchedBy';

/** False for an order whose customer was matched from what a buyer typed (`CUSTOMER_MATCHED_BY`). */
export const customerTrusted = (order: { meta?: Record<string, unknown> }) =>
  order.meta?.[CUSTOMER_MATCHED_BY] === undefined;
