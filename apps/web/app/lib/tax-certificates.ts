/**
 * The customer page's tax certificate form, read and shown: where a certificate covers, typed as
 * "US, US-CA" (a country, or a region of it), and its last day. Pure; `customers.server.ts` stores
 * what it parses through the engine.
 */

import type { TaxCertificateState, TaxPlace } from '@orderloop/core';

const PLACE_RE = /^([A-Z]{2})(?:-([A-Z0-9]{1,10}))?$/;

/**
 * "US, US-CA, ca-on" → `[{ country: 'US' }, { country: 'US', region: 'CA' }, { country: 'CA',
 * region: 'ON' }]`, each place once, or why it can't be read.
 */
export function parseTaxPlaces(text: string): TaxPlace[] | string {
  const tokens = text
    .toUpperCase()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (!tokens.length) return 'Name at least one country or region it covers, such as US or US-CA.';
  const places = new Map<string, TaxPlace>();
  for (const t of tokens) {
    const m = PLACE_RE.exec(t);
    if (!m) return `“${t}” isn’t a country (US) or a region of one (US-CA).`;
    places.set(t, { country: m[1]!, ...(m[2] ? { region: m[2] } : {}) });
  }
  return [...places.values()];
}

/** "US, US-CA": as the form takes them. */
export const placesLabel = (places: readonly TaxPlace[]) =>
  places.map((p) => (p.region ? `${p.country}-${p.region}` : p.country)).join(', ');

/**
 * A certificate's last day from a date field ("2027-06-30") as the end of that day in UTC, null
 * when left empty, or why it can't be read.
 */
export function expiryFrom(value: string): number | null | string {
  const v = value.trim();
  if (!v) return null;
  const at = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T23:59:59.999Z`) : Number.NaN;
  return Number.isNaN(at) ? 'The expiry is not a date.' : at;
}

/** The expiry as the date field had it ("2027-06-30"). */
export const expiryDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** How each state reads, and the status token it takes. */
export const CERTIFICATE_STATES: Record<
  TaxCertificateState,
  { label: string; tone: 'ok' | 'wait' | 'bad' | 'idle' }
> = {
  active: { label: 'Exempts', tone: 'ok' },
  unverified: { label: 'Unverified', tone: 'wait' },
  expired: { label: 'Expired', tone: 'bad' },
  revoked: { label: 'Revoked', tone: 'idle' },
};
