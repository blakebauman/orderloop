/**
 * Tax exemption certificates: a business customer's proof (a resale or exempt-organization
 * certificate, say) that it pays no sales tax in the places the certificate covers. Staff add,
 * verify and revoke them on the customer's page; a buyer never claims one. `commerce.tax` charges
 * no tax on an order whose customer holds one that is in force where the order ships
 * (`exemptingCertificate`), or hands it to the tax provider to decide.
 */

import { z } from 'zod';
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
  createdBy: string;
  createdAt: number;
  /** Who checked it against the issuing authority; unverified exempts nothing. */
  verifiedBy: string | null;
  verifiedAt: number | null;
  revokedBy: string | null;
  revokedAt: number | null;
};

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
  id: z.string().regex(/^txc_[a-z0-9]{1,40}$/),
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

/** Whether a certificate is in force at `now`, and if not, why not. */
export function taxCertificateState(
  c: Pick<TaxCertificate, 'status' | 'verifiedAt' | 'expiresAt'>,
  now: number,
): TaxCertificateState {
  if (c.status === 'revoked') return 'revoked';
  if (c.expiresAt !== null && now > c.expiresAt) return 'expired';
  if (c.verifiedAt === null) return 'unverified';
  return 'active';
}

/**
 * The certificate that exempts a sale to `country` and `region` at `now`: active, verified,
 * unexpired and covering the place. The first in `certs`' order (oldest first), so a replay picks
 * the same one. Null when none does.
 */
export function exemptingCertificate<
  C extends Pick<TaxCertificate, 'status' | 'verifiedAt' | 'expiresAt' | 'regions'>,
>(certs: readonly C[], country: string | undefined, region: string | undefined, now: number) {
  return (
    certs.find(
      (c) => taxCertificateState(c, now) === 'active' && coversPlace(c.regions, country, region),
    ) ?? null
  );
}

/** What a tax provider is told of a certificate that exempts the order: its number and coverage. */
export type TaxExemption = { certificate: string; regions: TaxPlace[] };

/** What a quote says when a certificate exempted it: "Tax exempt (certificate RS-1234)". */
export const taxExemptNote = (c: Pick<TaxCertificate, 'number'>) =>
  `Tax exempt (certificate ${c.number})`;
