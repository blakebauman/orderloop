import { type Principal, verifyRpcActor } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expiryDay, expiryFrom, parseTaxPlaces, placesLabel } from '../app/lib/tax-certificates';

const env = { PRINCIPAL_KEY: 'web-test-key' };
const addTaxCertificate = vi.fn();
const objects = new Map<string, { size: number; type?: string }>();

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ addTaxCertificate }),
  db: () => ({}),
  docs: () => ({
    put: async (key: string, body: ArrayBuffer, o: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { size: body.byteLength, type: o.httpMetadata?.contentType });
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  }),
}));
vi.mock('~/lib/audit.server', () => ({ actorName: (p: Principal) => p.email ?? p.name }));

const { addCertificate } = await import('../app/lib/customers.server');

describe('where a certificate covers, as typed', () => {
  it('reads countries and regions, upper-cased, each once', () => {
    expect(parseTaxPlaces('US-CA, us-ny;CA\nUS-CA')).toEqual([
      { country: 'US', region: 'CA' },
      { country: 'US', region: 'NY' },
      { country: 'CA' },
    ]);
    expect(placesLabel([{ country: 'US', region: 'CA' }, { country: 'CA' }])).toBe('US-CA, CA');
  });

  it('says what it can’t read', () => {
    expect(parseTaxPlaces('  ')).toMatch(/^Name at least one/);
    expect(parseTaxPlaces('US, California')).toBe(
      '“CALIFORNIA” isn’t a country (US) or a region of one (US-CA).',
    );
    expect(parseTaxPlaces('USA-CA')).toMatch(/isn’t a country/);
  });
});

describe('a certificate’s last day', () => {
  it('runs to the end of that day in UTC, or never', () => {
    expect(expiryFrom('2027-06-30')).toBe(Date.UTC(2027, 5, 30, 23, 59, 59, 999));
    expect(expiryDay(Date.UTC(2027, 5, 30, 23, 59, 59, 999))).toBe('2027-06-30');
    expect(expiryFrom('')).toBeNull();
    expect(expiryFrom('next June')).toBe('The expiry is not a date.');
  });
});

describe('adding a certificate', () => {
  const me: Principal = {
    kind: 'user',
    id: 'usr_1',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'operator',
  };
  const form = (fields: Record<string, string | File>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const pdf = () => new File(['%PDF-1.7'], 'resale.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    objects.clear();
    addTaxCertificate.mockReset();
  });

  it('stores the file at the certificate’s key and asks the engine as the person, for that customer', async () => {
    addTaxCertificate.mockImplementation(async (_c, input) => ({ ok: true, value: input }));
    const r = await addCertificate(
      'cus_1',
      me,
      form({ number: 'RS-1', regions: 'US-CA', expires: '2027-06-30', file: pdf() }),
    );
    expect(r).toMatchObject({ ok: true, number: 'RS-1' });
    const [customerId, input, signed] = addTaxCertificate.mock.calls[0]!;
    expect(customerId).toBe('cus_1');
    expect(input).toMatchObject({
      number: 'RS-1',
      regions: [{ country: 'US', region: 'CA' }],
      expiresAt: Date.UTC(2027, 5, 30, 23, 59, 59, 999),
      file: { name: 'resale.pdf', type: 'application/pdf', size: 8 },
    });
    expect(input.file.key).toBe(`customers/cus_1/tax-certificates/${input.id}`);
    expect([...objects.keys()]).toEqual([input.file.key]);
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], signed, 'tax-certificates:cus_1')).toEqual({
      kind: 'staff',
      id: 'usr_1',
      name: 'ada@example.com',
      role: 'operator',
    });
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], signed, 'tax-certificates:cus_2')).toBeNull();
  });

  it('deletes the file again when the engine refuses the certificate', async () => {
    addTaxCertificate.mockResolvedValue({ ok: false, error: 'This needs the Operator role.' });
    expect(
      await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: pdf() })),
    ).toEqual({ ok: false, error: 'This needs the Operator role.' });
    expect(objects.size).toBe(0);
  });

  it('refuses a file type or form it can’t take before storing anything', async () => {
    const html = new File(['<script>'], 'x.html', { type: 'text/html' });
    expect(
      await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: html })),
    ).toEqual({ ok: false, error: 'Attach a PDF or an image (PNG, JPEG, WebP).' });
    expect(await addCertificate('cus_1', me, form({ number: 'RS-1', regions: '' }))).toMatchObject({
      ok: false,
    });
    expect(objects.size).toBe(0);
    expect(addTaxCertificate).not.toHaveBeenCalled();
  });

  it('adds one without a file when none was chosen', async () => {
    addTaxCertificate.mockImplementation(async (_c, input) => ({ ok: true, value: input }));
    const empty = new File([], '', { type: 'application/octet-stream' });
    await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: empty }));
    expect(addTaxCertificate.mock.calls[0]![1]).toMatchObject({ file: null, expiresAt: null });
    expect(objects.size).toBe(0);
  });
});
