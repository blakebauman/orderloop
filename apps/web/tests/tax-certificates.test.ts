import type { Principal, TaxCertificate, TaxCertificateInput } from '@orderloop/core';
import { verifyRpcActor } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expiryDay, expiryFrom, parseTaxPlaces, placesLabel } from '../app/lib/tax-certificates';

const env = { PRINCIPAL_KEY: 'web-test-key' };
/** What the engine holds, by customer; a customer not here doesn't exist. */
const held = new Map<string, TaxCertificate[]>();
const addTaxCertificate = vi.fn();
const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
const requireUser = vi.fn();

const certificateOf = (customerId: string, i: TaxCertificateInput): TaxCertificate => ({
  ...i,
  customerId,
  status: 'active',
  createdBy: 'ada@example.com',
  createdById: 'usr_1',
  createdAt: 0,
  verifiedBy: null,
  verifiedAt: null,
  revokedBy: null,
  revokedAt: null,
});
/** The engine's add, as it behaves: stores it, or answers with the one already there. */
const engineAdds = async (customerId: string, i: TaxCertificateInput) => {
  const list = held.get(customerId)!;
  const already = list.find((c) => c.id === i.id);
  if (already) return { ok: true, value: { certificate: already, changed: false } };
  const certificate = certificateOf(customerId, i);
  list.push(certificate);
  return { ok: true, value: { certificate, changed: true } };
};

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    addTaxCertificate,
    taxCertificates: async (customerId: string) => held.get(customerId) ?? null,
  }),
  db: () => ({}),
  docs: () => ({
    put: async (key: string, body: Uint8Array, o: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { bytes: new Uint8Array(body), type: o.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objects.get(key);
      return o ? { body: new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream() } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  }),
}));
vi.mock('~/lib/audit.server', () => ({ actorName: (p: Principal) => p.email ?? p.name }));
vi.mock('~/lib/auth.server', () => ({ requireUser }));

const { addCertificate } = await import('../app/lib/customers.server');
const download = await import('../app/routes/tax-certificate-file');

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
    f.set('id', 'txc_abc123');
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const pdf = () => new File(['%PDF-1.7'], 'resale.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    objects.clear();
    held.clear();
    held.set('cus_1', []);
    addTaxCertificate.mockReset();
    addTaxCertificate.mockImplementation(engineAdds);
  });

  it('stores the file at the certificate’s key and asks the engine as the person, for that customer', async () => {
    const r = await addCertificate(
      'cus_1',
      me,
      form({ number: 'RS-1', regions: 'US-CA', expires: '2027-06-30', file: pdf() }),
    );
    expect(r).toEqual({ ok: true, id: 'txc_abc123', number: 'RS-1', changed: true });
    const [customerId, input, signed] = addTaxCertificate.mock.calls[0]!;
    expect(customerId).toBe('cus_1');
    expect(input).toEqual({
      id: 'txc_abc123',
      number: 'RS-1',
      regions: [{ country: 'US', region: 'CA' }],
      expiresAt: Date.UTC(2027, 5, 30, 23, 59, 59, 999),
      file: {
        key: 'customers/cus_1/tax-certificates/txc_abc123',
        name: 'resale.pdf',
        type: 'application/pdf',
        size: 8,
      },
    });
    expect([...objects.keys()]).toEqual([input.file.key]);
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], signed, 'tax-certificates:cus_1')).toEqual({
      kind: 'staff',
      id: 'usr_1',
      name: 'ada@example.com',
      role: 'operator',
    });
    expect(await verifyRpcActor([env.PRINCIPAL_KEY], signed, 'tax-certificates:cus_2')).toBeNull();
  });

  it('adds a form sent twice once, without storing its file again', async () => {
    const f = form({ number: 'RS-1', regions: 'US', file: pdf() });
    await addCertificate('cus_1', me, f);
    objects.clear();
    expect(await addCertificate('cus_1', me, f)).toEqual({
      ok: true,
      id: 'txc_abc123',
      number: 'RS-1',
      changed: false,
    });
    expect(held.get('cus_1')).toHaveLength(1);
    expect(addTaxCertificate).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(0);
  });

  it('deletes the file again when the engine refuses the certificate', async () => {
    addTaxCertificate.mockResolvedValue({ ok: false, error: 'This needs the Operator role.' });
    expect(
      await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: pdf() })),
    ).toEqual({ ok: false, error: 'This needs the Operator role.' });
    expect(objects.size).toBe(0);
  });

  it('deletes the file when the engine call throws, unless the engine added it after all', async () => {
    addTaxCertificate.mockRejectedValueOnce(new Error('engine unreachable'));
    await expect(
      addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: pdf() })),
    ).rejects.toThrow('engine unreachable');
    expect(objects.size).toBe(0);

    // Added, but the answer was lost: the certificate keeps its file.
    addTaxCertificate.mockImplementationOnce(async (c: string, i: TaxCertificateInput) => {
      await engineAdds(c, i);
      throw new Error('connection reset');
    });
    await expect(
      addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: pdf() })),
    ).rejects.toThrow('connection reset');
    expect([...objects.keys()]).toEqual(['customers/cus_1/tax-certificates/txc_abc123']);
  });

  it('stores nothing for a customer that doesn’t exist', async () => {
    expect(
      await addCertificate('cus_nobody', me, form({ number: 'RS-1', regions: 'US', file: pdf() })),
    ).toEqual({ ok: false, error: 'No such customer.' });
    expect(objects.size).toBe(0);
    expect(addTaxCertificate).not.toHaveBeenCalled();
  });

  it('refuses a file type, a file that isn’t what it says, or a form it can’t take, before storing anything', async () => {
    const html = new File(['<script>'], 'x.html', { type: 'text/html' });
    expect(
      await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: html })),
    ).toEqual({ ok: false, error: 'Attach a PDF or an image (PNG, JPEG, WebP).' });
    const fake = new File(['<html><script>'], 'fake.pdf', { type: 'application/pdf' });
    expect(
      await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: fake })),
    ).toEqual({ ok: false, error: 'The file isn’t a PDF.' });
    expect(await addCertificate('cus_1', me, form({ number: 'RS-1', regions: '' }))).toMatchObject({
      ok: false,
    });
    const noId = form({ number: 'RS-1', regions: 'US' });
    noId.set('id', '../../carts/x');
    expect(await addCertificate('cus_1', me, noId)).toEqual({
      ok: false,
      error: 'Reload the page and add it again.',
    });
    expect(objects.size).toBe(0);
    expect(addTaxCertificate).not.toHaveBeenCalled();
  });

  it('adds one without a file when none was chosen', async () => {
    const empty = new File([], '', { type: 'application/octet-stream' });
    await addCertificate('cus_1', me, form({ number: 'RS-1', regions: 'US', file: empty }));
    expect(addTaxCertificate.mock.calls[0]![1]).toMatchObject({ file: null, expiresAt: null });
    expect(objects.size).toBe(0);
  });
});

describe('downloading a certificate’s file', () => {
  const key = 'customers/cus_1/tax-certificates/txc_abc123';
  const get = (customerId: string, certificateId: string) =>
    download.loader({
      request: new Request(
        `https://app.test/customers/${customerId}/tax-certificates/${certificateId}`,
      ),
      params: { customerId, certificateId },
    } as never) as Promise<Response>;

  beforeEach(() => {
    objects.clear();
    held.clear();
    objects.set(key, { bytes: new TextEncoder().encode('%PDF-1.7'), type: 'application/pdf' });
    held.set('cus_1', [
      certificateOf('cus_1', {
        id: 'txc_abc123',
        number: 'RS-1',
        regions: [{ country: 'US' }],
        expiresAt: null,
        file: { key, name: 'resale “2027”.pdf', type: 'application/pdf', size: 8 },
      }),
    ]);
    held.set('cus_2', []);
    requireUser.mockReset();
    requireUser.mockResolvedValue({ kind: 'user', id: 'usr_v', name: 'Vi', role: 'viewer' });
  });

  it('serves it to a viewer as an attachment that runs nothing', async () => {
    const res = await get('cus_1', 'txc_abc123');
    expect(requireUser).toHaveBeenCalledWith(expect.any(Request));
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': '8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('resale “2027”.pdf')}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    expect(await res.text()).toBe('%PDF-1.7');
  });

  it('is not found under another customer, or for a certificate without a file', async () => {
    expect((await get('cus_2', 'txc_abc123')).status).toBe(404);
    expect((await get('cus_nobody', 'txc_abc123')).status).toBe(404);
    held.get('cus_1')![0]!.file = null;
    expect((await get('cus_1', 'txc_abc123')).status).toBe(404);
  });

  it('sends someone signed out to sign in', async () => {
    requireUser.mockRejectedValue(new Response(null, { status: 302 }));
    await expect(get('cus_1', 'txc_abc123')).rejects.toMatchObject({ status: 302 });
  });
});
