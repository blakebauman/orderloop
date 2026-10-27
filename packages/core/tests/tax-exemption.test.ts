import { describe, expect, it } from 'vitest';
import {
  checkTaxCertificateInput,
  coversPlace,
  exemptingCertificate,
  type TaxCertificate,
  taxCertificateFileProblem,
  taxCertificateKey,
  taxCertificateState,
  taxExemptNote,
  validateConfig,
  withDefaults,
} from '../src';

const NOW = Date.UTC(2026, 9, 27, 12);
const DAY = 86_400_000;

const cert = (c: Partial<TaxCertificate> = {}): TaxCertificate => ({
  id: 'txc_1',
  customerId: 'cus_1',
  number: 'RS-1',
  regions: [{ country: 'US', region: 'CA' }],
  expiresAt: null,
  file: null,
  status: 'active',
  createdBy: 'ann@example.com',
  createdAt: 0,
  verifiedBy: 'ann@example.com',
  verifiedAt: 1,
  revokedBy: null,
  revokedAt: null,
  ...c,
});

describe('commerce.tax config', () => {
  it('honors exemptions unless a flow turns them off, and takes only a boolean', () => {
    expect(withDefaults('commerce.tax', {}).exemptions).toBe(true);
    expect(validateConfig('commerce.tax', { exemptions: false })).toEqual([]);
    expect(validateConfig('commerce.tax', { exemptions: 'no' })).toEqual([
      expect.stringMatching(/^Honor exemptions:/),
    ]);
  });
});

describe('where a certificate covers', () => {
  const places = [{ country: 'US', region: 'CA' }, { country: 'CA' }];

  it('covers its regions, and every region of a whole country', () => {
    expect(coversPlace(places, 'US', 'CA')).toBe(true);
    expect(coversPlace(places, 'US', 'ca')).toBe(true);
    expect(coversPlace(places, 'CA', 'ON')).toBe(true);
    expect(coversPlace(places, 'CA', undefined)).toBe(true);
  });

  it('covers nothing else: another region, a country it names only a region of, or no country', () => {
    expect(coversPlace(places, 'US', 'NY')).toBe(false);
    // Without the ship-to's region, a certificate for one region of the country can't be matched.
    expect(coversPlace(places, 'US', undefined)).toBe(false);
    expect(coversPlace(places, 'DE', undefined)).toBe(false);
    expect(coversPlace(places, undefined, 'CA')).toBe(false);
  });
});

describe('a certificate in force', () => {
  it('is active only verified, unrevoked and unexpired', () => {
    expect(taxCertificateState(cert(), NOW)).toBe('active');
    expect(taxCertificateState(cert({ verifiedAt: null }), NOW)).toBe('unverified');
    expect(taxCertificateState(cert({ status: 'revoked' }), NOW)).toBe('revoked');
    expect(taxCertificateState(cert({ expiresAt: NOW - 1 }), NOW)).toBe('expired');
    // Through the end of its last day.
    expect(taxCertificateState(cert({ expiresAt: NOW }), NOW)).toBe('active');
  });

  it('exempts with the first that is in force and covers the place', () => {
    const certs = [
      cert({ id: 'old', expiresAt: NOW - DAY }),
      cert({ id: 'unverified', verifiedAt: null }),
      cert({ id: 'revoked', status: 'revoked' }),
      cert({ id: 'ny', regions: [{ country: 'US', region: 'NY' }] }),
      cert({ id: 'ca' }),
      cert({ id: 'ca2' }),
    ];
    expect(exemptingCertificate(certs, 'US', 'CA', NOW)?.id).toBe('ca');
    expect(exemptingCertificate(certs, 'US', 'NY', NOW)?.id).toBe('ny');
    expect(exemptingCertificate(certs, 'US', 'TX', NOW)).toBeNull();
    expect(exemptingCertificate(certs.slice(0, 3), 'US', 'CA', NOW)).toBeNull();
    // The run's time decides: the old one was in force a week ago.
    expect(exemptingCertificate(certs, 'US', 'CA', NOW - 7 * DAY)?.id).toBe('old');
  });

  it('says so on a quote', () => {
    expect(taxExemptNote(cert())).toBe('Tax exempt (certificate RS-1)');
  });
});

describe('adding a certificate', () => {
  const input = {
    id: 'txc_abc123',
    number: ' RS-1234 ',
    regions: [{ country: 'US', region: 'ca' }],
    expiresAt: null,
    file: null,
  };

  it('trims the number and upper-cases regions', () => {
    expect(checkTaxCertificateInput('cus_1', input)).toEqual({
      ok: true,
      value: { ...input, number: 'RS-1234', regions: [{ country: 'US', region: 'CA' }] },
    });
  });

  it('refuses no places, a bad number, or a file that is not this certificate’s', () => {
    expect(checkTaxCertificateInput('cus_1', { ...input, regions: [] })).toMatchObject({
      ok: false,
      error: 'Name at least one country or region it covers.',
    });
    expect(checkTaxCertificateInput('cus_1', { ...input, number: 'RS\n1' })).toMatchObject({
      ok: false,
    });
    const file = {
      key: taxCertificateKey('cus_2', input.id),
      name: 'c.pdf',
      type: 'application/pdf',
      size: 10,
    };
    expect(checkTaxCertificateInput('cus_1', { ...input, file })).toEqual({
      ok: false,
      error: 'The file is not this certificate’s.',
    });
    expect(
      checkTaxCertificateInput('cus_1', {
        ...input,
        file: { ...file, key: taxCertificateKey('cus_1', input.id), type: 'text/html' },
      }),
    ).toEqual({ ok: false, error: 'Attach a PDF or an image (PNG, JPEG, WebP).' });
  });

  it('takes a PDF or an image up to 10 MB', () => {
    expect(taxCertificateFileProblem({ type: 'application/pdf', size: 1 })).toBeNull();
    expect(taxCertificateFileProblem({ type: 'image/jpeg', size: 10 * 1024 * 1024 })).toBeNull();
    expect(taxCertificateFileProblem({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 })).toBe(
      'A file is at most 10 MB.',
    );
    expect(taxCertificateFileProblem({ type: 'image/svg+xml', size: 1 })).not.toBeNull();
  });
});
