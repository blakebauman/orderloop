import { env } from 'cloudflare:workers';
import {
  APPROVAL_SEPARATION_KEY,
  type CartActor,
  type Order,
  type Role,
  type RpcActor,
  type RunContext,
  shopifyToInbound,
  type TaxCertificateInput,
  taxCertificateKey,
  toStartRequest,
  withDefaults,
} from '@orderloop/core';
import {
  createDb,
  customers,
  publishFlow,
  taxCertificates,
  workspaceSettings,
} from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { createCart } from '../src/cart/carts';
import { ensureTemplates } from '../src/flows';
import { EXECUTORS } from '../src/nodes';
import { startOrder } from '../src/orders';
import { eraseDataSubject, exportDataSubject } from '../src/subjects';
import { edge, node, settled } from './plugin-helpers';
import { signedActor } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const DAY = 86_400_000;
const california = {
  line1: '1 Main St',
  city: 'Oakland',
  region: 'CA',
  postalCode: '94607',
  country: 'US',
};

const staff = (role: Role) => ({
  kind: 'staff' as const,
  id: `usr_tax_${role}`,
  name: `${role}@example.com`,
  role,
});
const operator = staff('operator');
const checker = { ...staff('operator'), id: 'usr_tax_checker', name: 'checker@example.com' };
const as = (customerId: string, a: RpcActor = operator) =>
  signedActor(a, `tax-certificates:${customerId}`);

/** A business customer of its own, so each test's certificates are its alone. */
async function customer() {
  const id = `cus_tax_${crypto.randomUUID().slice(0, 8)}`;
  await db()
    .insert(customers)
    .values({ id, name: `Exempt ${id}`, email: `${id}@example.com`, kind: 'business' });
  return id;
}

const input = (over: Partial<TaxCertificateInput> = {}): TaxCertificateInput => ({
  id: `txc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
  number: 'RS-1234',
  regions: [{ country: 'US', region: 'CA' }],
  expiresAt: null,
  file: null,
  ...over,
});

/** Adds a certificate as an operator, verified by another unless told not to. */
async function certify(customerId: string, over: Partial<TaxCertificateInput> = {}, verify = true) {
  const added = await api().addTaxCertificate(customerId, input(over), await as(customerId));
  if (!added.ok) throw new Error(added.error);
  if (verify) {
    const v = await api().verifyTaxCertificate(
      customerId,
      added.value.certificate.id,
      await as(customerId, checker),
    );
    if (!v.ok) throw new Error(v.error);
  }
  return added.value.certificate;
}

/** Moves when a customer's certificates were verified or revoked, as if it happened at `at`. */
const happened = (customerId: string, at: Partial<typeof taxCertificates.$inferInsert>) =>
  db().update(taxCertificates).set(at).where(eq(taxCertificates.customerId, customerId));

const order = (customerId: string, o: Partial<Order> = {}): Order => ({
  id: `ord_tax_${crypto.randomUUID().slice(0, 8)}`,
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId,
  lines: [{ sku: 'WID-100', qty: 2, unitPrice: 50 }],
  meta: { shipTo: california },
  createdAt: 0,
  subtotal: 100,
  shipping: 10,
  tax: 0,
  total: 110,
  fxRate: 1,
  ...o,
});

/** Runs the tax node on `o` at `now`, as its step would. */
async function tax(o: Order, config: Record<string, unknown> = {}, now = Date.now()) {
  const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now, ref: o.id };
  return EXECUTORS['commerce.tax']!({
    env,
    node: node('tax', 'commerce.tax'),
    config: withDefaults('commerce.tax', { rate: 0.1, ...config }),
    ctx,
    stepKey: 'tax#1',
  });
}

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('commerce.tax with an exemption certificate', () => {
  it('charges no tax, and records the certificate by id, not its number', async () => {
    const id = await customer();
    const c = await certify(id);
    const r = await tax(order(id));
    expect(r.order).toMatchObject({ tax: 0, taxRate: 0, total: 110 });
    expect(r.output).toMatchObject({
      rate: 0,
      exemption: { certificateId: c.id, exempted: true },
    });
    expect(JSON.stringify(r)).not.toContain('RS-1234');
    expect(r.summary).toBe('Tax exempt (certificate on file) · total $110.00');
  });

  it('exempts a whole country’s certificate in any of its regions', async () => {
    const id = await customer();
    await certify(id, { regions: [{ country: 'US' }] });
    expect((await tax(order(id))).order).toMatchObject({ tax: 0 });
  });

  it('taxes when the certificate is expired, revoked, unverified or for another region', async () => {
    // Verified while it was in force, since expired.
    const expired = await customer();
    await certify(expired, { expiresAt: Date.now() + DAY });
    await db()
      .update(taxCertificates)
      .set({ expiresAt: Date.now() - DAY })
      .where(eq(taxCertificates.customerId, expired));
    const revoked = await customer();
    const r = await certify(revoked);
    expect(await api().revokeTaxCertificate(revoked, r.id, await as(revoked))).toMatchObject({
      ok: true,
      value: {
        certificate: { status: 'revoked', revokedBy: 'operator@example.com' },
        changed: true,
      },
    });
    const unverified = await customer();
    await certify(unverified, {}, false);
    const elsewhere = await customer();
    await certify(elsewhere, { regions: [{ country: 'US', region: 'NY' }, { country: 'CA' }] });

    for (const id of [expired, revoked, unverified, elsewhere]) {
      const t = await tax(order(id));
      expect([id, t.order?.tax]).toEqual([id, 11]);
      expect(t.output).not.toHaveProperty('exemption');
      expect(t.summary).toBe('Tax $11.00 · total $121.00');
    }
  });

  it('judges expiry as of when the order was placed (the run’s now), not the clock', async () => {
    const id = await customer();
    const expiresAt = Date.now() - DAY;
    await certify(id, { expiresAt: Date.now() + DAY });
    // Expired by the clock now, but verified and in force when the order was placed.
    await happened(id, { expiresAt, verifiedAt: expiresAt - 3 * DAY });
    expect((await tax(order(id), {}, expiresAt - DAY)).order).toMatchObject({ tax: 0 });
    expect((await tax(order(id))).order).toMatchObject({ tax: 11 });
  });

  it('judges revoking and verifying as of when the order was placed', async () => {
    const id = await customer();
    const c = await certify(id);
    await api().revokeTaxCertificate(id, c.id, await as(id));
    const placed = Date.now() - DAY;
    // Revoked after the order was placed: it was still in force for that order.
    await happened(id, { verifiedAt: placed - DAY, revokedAt: placed + 1 });
    expect((await tax(order(id), {}, placed)).order).toMatchObject({ tax: 0 });
    // Revoked before it: not.
    await happened(id, { revokedAt: placed - 1 });
    expect((await tax(order(id), {}, placed)).order).toMatchObject({ tax: 11 });

    // Verified only after the order was placed: that order isn't exempt.
    const later = await customer();
    await certify(later);
    expect((await tax(order(later), {}, placed)).order).toMatchObject({ tax: 11 });
    expect((await tax(order(later))).order).toMatchObject({ tax: 0 });
  });

  it('gives nothing to a customer matched from a Shopify buyer’s email, or a name in a document', async () => {
    const id = await customer();
    await certify(id);
    // What the Shopify webhook starts when a guest's email matches the exempt account.
    const mapped = shopifyToInbound(
      {
        id: 4501,
        email: `${id}@example.com`,
        currency: 'USD',
        line_items: [{ sku: 'WID-100', title: 'Widget', quantity: 2, price: '50.00' }],
        shipping_address: {
          address1: '1 Main St',
          city: 'Oakland',
          zip: '94607',
          province_code: 'CA',
          country_code: 'US',
        },
      },
      { customerId: id },
    );
    if (!mapped.ok) throw new Error(mapped.error);
    const { input: started } = toStartRequest(
      { ...mapped.order, channel: 'web', externalId: '4501' } as never,
      'tpl-storefront-order',
    );
    expect(started.customerId).toBe(id);
    const fromShopify = await tax(order(id, { meta: started.meta }));
    expect(fromShopify.order).toMatchObject({ tax: 11 });
    expect(fromShopify.output).not.toHaveProperty('exemption');
    const byName = await tax(
      order(id, { meta: { shipTo: california, customerMatchedBy: 'name' } }),
    );
    expect(byName.order).toMatchObject({ tax: 11 });
    // Named by a trusted caller, the same customer is exempt.
    expect((await tax(order(id))).order).toMatchObject({ tax: 0 });
  });

  it('needs a region on the ship-to for a region’s certificate, and a ship-to at all', async () => {
    const id = await customer();
    await certify(id);
    const { region: _r, ...noRegion } = california;
    expect((await tax(order(id, { meta: { shipTo: noRegion } }))).order).toMatchObject({ tax: 11 });
    expect((await tax(order(id, { meta: {} }))).order).toMatchObject({ tax: 11 });
  });

  it('taxes as usual when the flow turns exemptions off', async () => {
    const id = await customer();
    await certify(id);
    const r = await tax(order(id), { exemptions: false });
    expect(r.order).toMatchObject({ tax: 11 });
    expect(r.output).not.toHaveProperty('exemption');
  });

  it('exempts an order the Workflow runs, start to end', async () => {
    const id = await customer();
    const c = await certify(id);
    await publishFlow(db(), {
      id: 'test-tax-exempt',
      name: 'Tax exempt',
      description: '',
      model: 'b2b',
      channels: [],
      nodes: [
        node('start', 'trigger.manual'),
        node('price', 'commerce.price'),
        node('tax', 'commerce.tax', { rate: 0.1 }),
        node('done', 'control.end', { outcome: 'completed', reason: 'priced' }),
      ],
      edges: [edge('start', 'price'), edge('price', 'tax'), edge('tax', 'done')],
    });
    const { orderId } = await startOrder(env, {
      flowId: 'test-tax-exempt',
      input: {
        model: 'b2b',
        channel: 'api',
        currency: 'USD',
        customerId: id,
        lines: [{ sku: 'WID-100', qty: 2 }],
        meta: { shipTo: california },
      },
    });
    const done = await settled(orderId, 30_000, { rollback: false });
    expect(done.status).toBe('completed');
    expect(done.order).toMatchObject({ tax: 0 });
    expect(done.order!.total).toBe(done.order!.subtotal);
    expect(done.nodes.tax).toMatchObject({
      summary: expect.stringMatching(/^Tax exempt \(certificate on file\)/),
      output: expect.objectContaining({ exemption: { certificateId: c.id, exempted: true } }),
    });

    // Erased afterwards, the order holds nothing of the certificate's number.
    expect(await eraseDataSubject(env, `${id}@example.com`)).toMatchObject({
      ok: true,
      taxCertificates: 1,
    });
    const erased = await env.ORDER_AGENT.getByName(orderId).snapshot();
    expect(JSON.stringify(erased)).not.toContain('RS-1234');
  });
});

describe('a cart for an exempt customer', () => {
  it('quotes no tax and says which certificate exempts it', async () => {
    const id = await customer();
    await certify(id, { number: 'CA-RESALE-9' });
    const made = await createCart(env, {
      title: 'Exempt restock',
      flowId: 'tpl-storefront-order',
      customerId: id,
      createdBy: 'usr_tax_operator',
    });
    if (!made.ok) throw new Error(made.error);
    const cart = env.CART_AGENT.getByName(made.id);
    const ops: CartActor = operator;
    expect(await cart.applyAs(ops, { op: 'add', sku: 'GSK-010', qty: 2 })).toEqual({ ok: true });
    expect(await cart.applyAs(ops, { op: 'set_ship_to', address: california })).toEqual({
      ok: true,
    });
    const c = (await api().cartSnapshot(made.id))!.cart!;
    expect(c.quote).toMatchObject({ tax: 0 });
    expect(c.quote!.subtotal).toBeGreaterThan(0);
    expect(c.issues).toContainEqual({
      kind: 'info',
      code: 'tax_exempt',
      content: 'Tax exempt (certificate CA-RESALE-9)',
    });
  });
});

describe('erasing a customer with an exempt cart', () => {
  it('drops the note naming the certificate from the cart', async () => {
    const id = await customer();
    await certify(id, { number: 'CA-RESALE-7' });
    const made = await createCart(env, {
      title: 'Exempt order',
      flowId: 'tpl-storefront-order',
      customerId: id,
      createdBy: 'usr_tax_operator',
    });
    if (!made.ok) throw new Error(made.error);
    const cart = env.CART_AGENT.getByName(made.id);
    await cart.applyAs(operator, { op: 'add', sku: 'GSK-010', qty: 1 });
    await cart.applyAs(operator, { op: 'set_ship_to', address: california });
    expect(JSON.stringify((await api().cartSnapshot(made.id))!.cart)).toContain('CA-RESALE-7');
    expect(await eraseDataSubject(env, `${id}@example.com`)).toMatchObject({ ok: true });
    const after = (await api().cartSnapshot(made.id))!.cart!;
    expect(after.issues.map((i) => i.code)).not.toContain('tax_exempt');
    expect(JSON.stringify(after)).not.toContain('CA-RESALE-7');
  });
});

describe('certificate calls', () => {
  it('take an operator signed for that customer, and refuse anyone else', async () => {
    const id = await customer();
    const other = await customer();
    const first = input();
    for (const [actor, error] of [
      [await as(id, staff('viewer')), 'This needs the Operator role.'],
      [await as(id, staff('approver')), 'This needs the Operator role.'],
      [await as(other), 'This call must name who is acting.'],
      [await signedActor(operator, `cart:${id}`), 'This call must name who is acting.'],
      ['not-signed', 'This call must name who is acting.'],
    ] as const) {
      expect(await api().addTaxCertificate(id, first, actor)).toEqual({ ok: false, error });
      expect(await api().verifyTaxCertificate(id, first.id, actor)).toEqual({ ok: false, error });
      expect(await api().revokeTaxCertificate(id, first.id, actor)).toEqual({ ok: false, error });
    }
    expect(await api().taxCertificates(id)).toEqual([]);

    const added = await api().addTaxCertificate(id, first, await as(id, staff('admin')));
    expect(added).toMatchObject({
      ok: true,
      value: {
        certificate: {
          id: first.id,
          status: 'active',
          verifiedAt: null,
          createdBy: 'admin@example.com',
          createdById: 'usr_tax_admin',
        },
        changed: true,
      },
    });
    // A retried add answers with the same certificate rather than a second, and says so.
    expect(await api().addTaxCertificate(id, first, await as(id))).toEqual({
      ok: true,
      value: {
        certificate: (added as { value: { certificate: unknown } }).value.certificate,
        changed: false,
      },
    });
    expect(await api().taxCertificates(id)).toHaveLength(1);
    expect(await api().taxCertificates('cus_nobody')).toBeNull();
    // Another customer's certificate isn't found through this one.
    expect(await api().verifyTaxCertificate(other, first.id, await as(other))).toEqual({
      ok: false,
      error: 'No such certificate.',
    });
  });

  it('refuses a file stored for another certificate, and verifying a revoked or expired one', async () => {
    const id = await customer();
    const bad = input();
    expect(
      await api().addTaxCertificate(
        id,
        {
          ...bad,
          file: {
            key: taxCertificateKey(id, 'txc_someoneelse'),
            name: 'c.pdf',
            type: 'application/pdf',
            size: 10,
          },
        },
        await as(id),
      ),
    ).toEqual({ ok: false, error: 'The file is not this certificate’s.' });
    expect(await api().addTaxCertificate('cus_nobody', bad, await as('cus_nobody'))).toEqual({
      ok: false,
      error: 'No such customer.',
    });

    expect(
      await api().addTaxCertificate(
        id,
        input({ regions: [{ country: 'US', region: 'CAL' }] }),
        await as(id),
      ),
    ).toEqual({ ok: false, error: 'US-CAL isn’t a region of US.' });

    const old = await certify(id, { expiresAt: Date.now() - DAY }, false);
    expect(await api().verifyTaxCertificate(id, old.id, await as(id))).toEqual({
      ok: false,
      error: 'The certificate has expired; add the renewed one.',
    });
    const c = await certify(id);
    const again = await api().verifyTaxCertificate(id, c.id, await as(id, staff('admin')));
    // Verifying twice keeps the first verifier, and changes nothing.
    expect(again).toMatchObject({
      ok: true,
      value: { certificate: { verifiedBy: 'checker@example.com' }, changed: false },
    });
    await api().revokeTaxCertificate(id, c.id, await as(id));
    expect(await api().revokeTaxCertificate(id, c.id, await as(id))).toMatchObject({
      ok: true,
      value: {
        certificate: { status: 'revoked', revokedBy: 'operator@example.com' },
        changed: false,
      },
    });
    expect(await api().verifyTaxCertificate(id, c.id, await as(id))).toEqual({
      ok: false,
      error: 'The certificate was revoked; add a new one.',
    });
    // Revoked, kept for the record.
    expect((await api().taxCertificates(id))!.map((x) => [x.id, x.status])).toEqual([
      [old.id, 'active'],
      [c.id, 'revoked'],
    ]);
  });
});

describe('separation of duties', () => {
  it('lets whoever added a certificate verify it only while approval separation is off', async () => {
    const id = await customer();
    const a = await certify(id, {}, false);
    expect(await api().verifyTaxCertificate(id, a.id, await as(id))).toMatchObject({
      ok: true,
      value: { changed: true },
    });

    const b = await certify(id, {}, false);
    await db().insert(workspaceSettings).values({
      key: APPROVAL_SEPARATION_KEY,
      value: 'on',
      updatedAt: Date.now(),
      updatedBy: 'test',
    });
    try {
      expect(await api().verifyTaxCertificate(id, b.id, await as(id))).toEqual({
        ok: false,
        error: 'Someone other than whoever added the certificate must verify it.',
      });
      expect(await api().verifyTaxCertificate(id, b.id, await as(id, checker))).toMatchObject({
        ok: true,
        value: { certificate: { verifiedBy: 'checker@example.com' }, changed: true },
      });
    } finally {
      await db()
        .delete(workspaceSettings)
        .where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY));
    }
  });
});

describe('erasing an exempt customer', () => {
  it('exports their certificates, then deletes the rows and files', async () => {
    const id = await customer();
    const email = `${id}@example.com`;
    const withFile = input();
    const key = taxCertificateKey(id, withFile.id);
    await env.DOCS.put(key, '%PDF-1.7');
    await certify(id, {
      ...withFile,
      file: { key, name: 'resale.pdf', type: 'application/pdf', size: 8 },
    });
    await certify(id, { number: 'RS-2' }, false);

    const exported = await exportDataSubject(env, email);
    expect(exported.taxCertificates).toEqual([
      expect.objectContaining({ id: withFile.id, number: 'RS-1234', fileKey: key }),
      expect.objectContaining({ number: 'RS-2', regions: [{ country: 'US', region: 'CA' }] }),
    ]);

    expect(await eraseDataSubject(env, email)).toMatchObject({ ok: true, taxCertificates: 2 });
    expect(
      await db().select().from(taxCertificates).where(eq(taxCertificates.customerId, id)),
    ).toEqual([]);
    expect(await env.DOCS.get(key)).toBeNull();
    expect(await api().taxCertificates(id)).toEqual([]);
    expect(await eraseDataSubject(env, `erased-${id}@erased.invalid`)).toMatchObject({
      ok: true,
      taxCertificates: 0,
    });
  });
});
