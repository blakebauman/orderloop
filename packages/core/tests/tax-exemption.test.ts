import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_MATCHED_BY,
  checkTaxCertificateInput,
  coversPlace,
  customerTrusted,
  exemptingCertificate,
  type Order,
  type ProvideRequest,
  providerRequest,
  shopifyToInbound,
  type TaxCertificate,
  taxCertificateFileMatches,
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
  createdById: 'usr_ann',
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

  it('counts verifying and revoking from when they happened', () => {
    // Revoked after the order was placed: still in force for it.
    expect(taxCertificateState(cert({ status: 'revoked', revokedAt: NOW + 1 }), NOW)).toBe(
      'active',
    );
    expect(taxCertificateState(cert({ status: 'revoked', revokedAt: NOW }), NOW)).toBe('revoked');
    // Verified after it: not yet.
    expect(taxCertificateState(cert({ verifiedAt: NOW + 1 }), NOW)).toBe('unverified');
    expect(taxCertificateState(cert({ verifiedAt: NOW }), NOW)).toBe('active');
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

  it('says so on a quote, and only “on file” without the number', () => {
    expect(taxExemptNote(cert())).toBe('Tax exempt (certificate RS-1)');
    expect(taxExemptNote({})).toBe('Tax exempt (certificate on file)');
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

  it('refuses a region its country doesn’t have, and takes any for a country with none listed', () => {
    expect(
      checkTaxCertificateInput('cus_1', { ...input, regions: [{ country: 'US', region: 'CAL' }] }),
    ).toEqual({ ok: false, error: 'US-CAL isn’t a region of US.' });
    expect(
      checkTaxCertificateInput('cus_1', { ...input, regions: [{ country: 'CA', region: 'on' }] }),
    ).toMatchObject({ ok: true, value: { regions: [{ country: 'CA', region: 'ON' }] } });
    expect(
      checkTaxCertificateInput('cus_1', { ...input, regions: [{ country: 'DE', region: 'BY' }] }),
    ).toMatchObject({ ok: true });
  });

  it('checks a file starts as its type does', () => {
    const bytes = (...b: (number | string)[]) =>
      new Uint8Array(
        b.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])),
      );
    expect(taxCertificateFileMatches('application/pdf', bytes('%PDF-1.7'))).toBe(true);
    expect(taxCertificateFileMatches('application/pdf', bytes('<html>'))).toBe(false);
    expect(taxCertificateFileMatches('image/png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      true,
    );
    expect(taxCertificateFileMatches('image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(taxCertificateFileMatches('image/webp', bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe(true);
    expect(taxCertificateFileMatches('image/webp', bytes('RIFF', 0, 0, 0, 0, 'AVI '))).toBe(false);
    expect(taxCertificateFileMatches('text/html', bytes('%PDF-'))).toBe(false);
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

describe('whose customer may be exempt', () => {
  it('not one matched from a Shopify buyer’s email', () => {
    const mapped = shopifyToInbound(
      {
        id: 1,
        currency: 'USD',
        email: 'a@b.example',
        line_items: [{ sku: 'X', title: 'X', quantity: 1, price: '1' }],
      },
      { customerId: 'cus_1' },
    );
    expect(mapped).toMatchObject({ ok: true, order: { meta: { [CUSTOMER_MATCHED_BY]: 'email' } } });
    expect(customerTrusted((mapped as { order: { meta: Record<string, unknown> } }).order)).toBe(
      false,
    );
    // No match, no flag.
    const guest = shopifyToInbound({ id: 2, currency: 'USD', line_items: [] });
    expect((guest as { order: { meta: Record<string, unknown> } }).order.meta).not.toHaveProperty(
      CUSTOMER_MATCHED_BY,
    );
    expect(customerTrusted({ meta: {} })).toBe(true);
  });
});

describe('a tax provider’s request', () => {
  const order = {
    id: 'ord_1',
    lines: [],
    meta: { shipTo: { name: 'Ann' } },
  } as unknown as Order;
  const req: ProvideRequest = {
    surface: 'tax',
    op: 'calculate',
    nodeId: 'tax',
    stepKey: 'tax#1',
    orderId: 'ord_1',
    config: {},
    order,
    input: {
      subtotal: 10,
      shipping: 0,
      includeShipping: true,
      currency: 'USD',
      exemption: { certificate: 'RS-1', regions: [{ country: 'US' }] },
    },
  };

  it('carries the certificate number only to a plugin granted buyer details', () => {
    expect(providerRequest({ personalData: 'send' }, req)).toMatchObject({
      input: { exemption: { certificate: 'RS-1', regions: [{ country: 'US' }] } },
    });
    const redacted = providerRequest({ personalData: 'redact' }, req);
    expect(redacted).toMatchObject({ input: { exemption: { regions: [{ country: 'US' }] } } });
    expect(JSON.stringify(redacted)).not.toContain('RS-1');
  });
});
