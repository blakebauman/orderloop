import { env } from 'cloudflare:workers';
import {
  checkPluginView,
  type ExternalCartInput,
  PLUGIN_VIEW_TYPE,
  type PluginCart,
  type PluginStartOrder,
  type PluginView,
  PRINCIPAL_HEADER,
  signPrincipal,
} from '@orderloop/core';
import { pluginContract } from '@orderloop/plugin-sdk/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import PunchoutPlugin from '../src/index';
import { at, parseXml } from '../src/xml';
import orderXml from './fixtures/order-request.xml?raw';
import setupXml from './fixtures/setup-request.xml?raw';

const KEY = 'punchout-test-key';
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** The core's host API, recording what the plugin asked of it. */
function fakeHost() {
  const opened: ExternalCartInput[] = [];
  const started: PluginStartOrder[] = [];
  return {
    opened,
    started,
    ended: new Set<string>(),
    async openExternalCart(input: ExternalCartInput) {
      if (this.ended.has(input.sessionRef))
        return { ok: false as const, error: 'That session’s cart is returned.' };
      opened.push(input);
      const cartId = `cart_${opened.length}`;
      return {
        ok: true as const,
        cart: {
          cartId,
          startPath: `/cart/start/${cartId}/tok`,
          startUrl: `https://app.orderloop.test/cart/start/${cartId}/tok`,
        },
      };
    },
    checked: [] as ExternalCartInput[],
    /** How the host answers a check: as granted, refused (no `carts:external`) or unreachable. */
    checks: 'granted' as 'granted' | 'refused' | 'down',
    async checkExternalCart(input: ExternalCartInput) {
      if (this.checks === 'down') throw new Error('D1_ERROR: internal detail');
      if (this.checks === 'refused')
        return { ok: false as const, error: 'This plugin may not open carts here.' };
      this.checked.push(input);
      // As the core answers: its own host refused (and then nothing else looked up), an unknown
      // flow or customer reported.
      if (new URL(input.returnUrl).hostname.endsWith('orderloop.test'))
        return {
          ok: true as const,
          problems: {
            input: 'returnUrl must be the buyer’s system, not this one',
            flow: null,
            customer: null,
          },
        };
      return {
        ok: true as const,
        problems: {
          input: null,
          flow: input.flowId === 'flow_nope' ? 'That flow has no published version.' : null,
          customer: input.customerId === 'cus_nope' ? 'No such customer.' : null,
        },
      };
    },
    async getCart() {
      return null;
    },
    cancelled: [] as string[],
    finished: new Set<string>(),
    /** Ends only once a cancel reaches it: after the status check, before the cancel. */
    finishing: new Set<string>(),
    async startOrder(req: PluginStartOrder) {
      // As the core does: a key starts one order, and a currency with no rate is refused.
      const i = started.findIndex((s) => s.key === req.key);
      if (i >= 0) return { ok: true as const, orderId: `ord_${i + 1}`, replayed: true };
      if (req.input.currency === 'XXX')
        return { ok: false as const, error: 'No exchange rate for XXX' };
      started.push(req);
      return { ok: true as const, orderId: `ord_${started.length}`, replayed: false };
    },
    async orderStatus(req: { key: string }) {
      const i = started.findIndex((s) => s.key === req.key);
      if (i < 0) return { ok: false as const, error: 'No order was started under that key.' };
      const status = this.finished.has(req.key)
        ? ('completed' as const)
        : this.cancelled.includes(req.key)
          ? ('cancelled' as const)
          : ('running' as const);
      return { ok: true as const, orderId: `ord_${i + 1}`, status, ended: status !== 'running' };
    },
    async cancelOrder(req: { key: string; reason: string }) {
      const i = started.findIndex((s) => s.key === req.key);
      if (i < 0) return { ok: false as const, error: 'No order was started under that key.' };
      if (this.finished.has(req.key) || this.finishing.has(req.key))
        return { ok: true as const, orderId: `ord_${i + 1}`, outcome: 'finished' as const };
      if (!this.cancelled.includes(req.key)) this.cancelled.push(req.key);
      return { ok: true as const, orderId: `ord_${i + 1}`, outcome: 'cancelled' as const };
    },
  };
}

let host: ReturnType<typeof fakeHost>;
let plugin: InstanceType<typeof PunchoutPlugin>;
beforeEach(async () => {
  host = fakeHost();
  plugin = new PunchoutPlugin(ctx, { ...env, ORDERLOOP: host } as never);
  await env.DB.prepare('DELETE FROM partners').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM purchase_orders').run();
});

/** An admin's request to the plugin's page, signed as the web app signs it. */
async function admin(path: string, form?: Record<string, string>) {
  const headers = new Headers({
    [PRINCIPAL_HEADER]: await signPrincipal(
      KEY,
      { kind: 'user', id: 'usr_admin', name: 'Admin', role: 'admin' },
      path,
    ),
  });
  return plugin.fetch(
    new Request(`https://plugin${path}`, {
      method: form ? 'POST' : 'GET',
      headers,
      ...(form ? { body: new URLSearchParams(form) } : {}),
    }),
  );
}

/** The secret a view shows once, in its `code` block. */
const secretIn = (view: PluginView) =>
  view.blocks.find((b): b is Extract<typeof b, { type: 'code' }> => b.type === 'code')?.text;

/** Adds a partner through the admin page and reads its secret off the page. */
async function partner(over: Record<string, string> = {}) {
  const res = await admin('/plugins/punchout/partners', {
    name: 'Northwind Ariba',
    protocol: 'cxml',
    fromDomain: 'NetworkID',
    identity: 'AN01000000001',
    customerId: 'cus_northwind',
    flowId: 'tpl-b2b-order',
    returnHosts: 'buyer.example',
    frameOrigins: 'https://buyer.example',
    ...over,
  });
  expect(res.headers.get('content-type')).toBe(PLUGIN_VIEW_TYPE);
  const view = (await res.json()) as PluginView;
  expect(checkPluginView(JSON.stringify(view)).ok).toBe(true);
  const secret = secretIn(view);
  if (!secret) throw new Error(`no secret on the page: ${JSON.stringify(view).slice(0, 400)}`);
  return secret;
}

const post = (path: string, body: string) =>
  plugin.fetch(new Request(`https://plugin${path}`, { method: 'POST', body }));
const status = async (res: Response) =>
  at(parseXml(await res.text()), 'Response/Status')?.attrs.code;

describe('cXML punchout', () => {
  it('opens a cart for a known buyer with the right secret, and answers its start page', async () => {
    const secret = await partner();
    const res = await post('/plugins/punchout/cxml/setup', setupXml.replace('SECRET', secret));
    expect(res.status).toBe(200);
    const doc = parseXml(await res.text());
    expect(at(doc, 'Response/PunchOutSetupResponse/StartPage/URL')?.text).toBe(
      'https://app.orderloop.test/cart/start/cart_1/tok',
    );
    expect(host.opened[0]).toMatchObject({
      flowId: 'tpl-b2b-order',
      customerId: 'cus_northwind',
      returnUrl: 'https://buyer.example/punchout/return?session=1&x=2',
      frameOrigins: ['https://buyer.example'],
      buyer: { id: 'ann.buyer@northwind.example', name: 'Ann & Co. Buyer' },
    });
    expect(host.opened[0]!.sessionRef).toMatch(/:34234234ADFSDF234234$/);
  });

  it('passes the partner’s idle timeout, so the cart stays open while its buyer works', async () => {
    const secret = await partner({ sessionMinutes: '30' });
    const before = Date.now();
    await post('/plugins/punchout/cxml/setup', setupXml.replace('SECRET', secret));
    const opened = host.opened[0]!;
    expect(opened.idleMs).toBe(30 * 60_000);
    expect(opened.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(opened.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    // A day at most, as the core caps it; a partner can't be given longer.
    const res = await admin('/plugins/punchout/partners', {
      name: 'Too long',
      protocol: 'oci',
      identity: 'longer',
      flowId: 'tpl-b2b-order',
      returnHosts: 'buyer.example',
      sessionMinutes: String(24 * 60 + 1),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/idle timeout is 5 minutes to 24 hours/);
  });

  it('refuses a wrong secret, an unknown buyer and a return to a host not theirs', async () => {
    const secret = await partner();
    const wrong = await post('/plugins/punchout/cxml/setup', setupXml.replace('SECRET', 'nope'));
    // cXML says what went wrong in its Status, over HTTP 200.
    expect(wrong.status).toBe(200);
    expect(await status(wrong)).toBe('401');
    const stranger = await post(
      '/plugins/punchout/cxml/setup',
      setupXml.replace('SECRET', secret).replaceAll('AN01000000001', 'AN09999999999'),
    );
    expect(await status(stranger)).toBe('401');
    const elsewhere = await post(
      '/plugins/punchout/cxml/setup',
      setupXml.replace('SECRET', secret).replace('https://buyer.example/', 'https://evil.example/'),
    );
    expect(await status(elsewhere)).toBe('403');
    const bad = await post('/plugins/punchout/cxml/setup', '<!DOCTYPE a [<!ENTITY x "y">]><a/>');
    expect(await status(bad)).toBe('400');
    expect(host.opened).toEqual([]);
  });

  it('opens a new cart when a returned session’s cookie is used again', async () => {
    const secret = await partner();
    const xml = setupXml
      .replace('SECRET', secret)
      .replace('operation="create"', 'operation="edit"');
    await post('/plugins/punchout/cxml/setup', xml);
    host.ended.add(host.opened[0]!.sessionRef);
    const again = await post('/plugins/punchout/cxml/setup', xml);
    expect(await status(again)).toBe('200');
    expect(host.opened).toHaveLength(2);
    expect(host.opened[1]!.sessionRef).toBe(
      `${host.opened[0]!.sessionRef}:1729760000.4321@buyer.example`,
    );
  });

  it('returns the cart as a PunchOutOrderMessage for its session', async () => {
    const secret = await partner();
    await post('/plugins/punchout/cxml/setup', setupXml.replace('SECRET', secret));
    const cart: PluginCart = {
      id: 'cart_1',
      title: 'x',
      status: 'locked',
      customerId: 'cus_northwind',
      lines: [{ id: 'li_1', sku: 'WID-100', qty: 5 }],
      quote: {
        currency: 'USD',
        lines: [
          {
            id: 'li_1',
            sku: 'WID-100',
            title: 'Industrial widget',
            qty: 5,
            unitPrice: 21.5,
            ships: true,
          },
        ],
        subtotal: 107.5,
        shipping: 0,
        tax: 0,
        total: 107.5,
        shippingOptions: [],
        shippingOption: null,
        ships: true,
      },
      orderId: null,
      updatedAt: 0,
      sessionRef: host.opened[0]!.sessionRef,
    };
    const { fields } = await plugin.renderReturn({ cart });
    expect(Object.keys(fields)).toEqual(['cxml-urlencoded']);
    const msg = parseXml(fields['cxml-urlencoded']!);
    expect(at(msg, 'Message/PunchOutOrderMessage/BuyerCookie')?.text).toBe('34234234ADFSDF234234');
    expect(at(msg, 'Header/To/Credential/Identity')?.text).toBe('AN01000000001');
    expect(
      at(msg, 'Message/PunchOutOrderMessage/ItemIn/ItemID/SupplierPartAuxiliaryID')?.text,
    ).toBe('cart_1:li_1');
    await expect(plugin.renderReturn({ cart: { ...cart, id: 'cart_x' } })).rejects.toThrow(
      /No punchout session/,
    );
  });

  it('starts the PO once per payload, for the partner’s flow and customer', async () => {
    const secret = await partner();
    const res = await post(
      '/plugins/punchout/cxml/order',
      orderXml.replace('SECRET', secret).replace('CARTID', 'cart_1'),
    );
    expect(res.status).toBe(200);
    expect(await status(res)).toBe('200');
    expect(host.started[0]).toMatchObject({
      flowId: 'tpl-b2b-order',
      input: {
        model: 'b2b',
        channel: 'edi',
        externalId: 'PO-7781',
        customerId: 'cus_northwind',
        currency: 'USD',
        lines: [{ sku: 'WID-100', qty: 5, name: 'Industrial widget' }],
        contact: { email: 'receiving@northwind.example', name: 'Northwind Receiving' },
        meta: { punchout: { orderId: 'PO-7781', carts: ['cart_1'] } },
      },
    });
    expect(host.started[0]!.key).toMatch(/^cxml:ptn_[a-z0-9]+:1729770000\.9876@buyer\.example$/);
    expect(await status(await post('/plugins/punchout/cxml/order', orderXml))).toBe('401');
  });
});

describe('changing and cancelling a purchase order', () => {
  const po = (secret: string, type: string, payload: string, qty = 5) =>
    orderXml
      .replace('SECRET', secret)
      .replace('type="new"', `type="${type}"`)
      .replace('payloadID="1729770000.9876@buyer.example"', `payloadID="${payload}"`)
      .replace('quantity="5"', `quantity="${qty}"`);
  const send = (xml: string) => post('/plugins/punchout/cxml/order', xml);
  const versions = () =>
    env.DB.prepare(
      'SELECT key, version, type, order_id FROM purchase_orders ORDER BY partner_id, version',
    )
      .all<{ key: string; version: number; type: string; order_id: string | null }>()
      .then((r) => r.results);
  const statusText = async (res: Response) => {
    const s = at(parseXml(await res.text()), 'Response/Status');
    return { code: s?.attrs.code, body: s?.text };
  };

  it('replaces the order on an update, cancels it on a delete, and ignores a resend', async () => {
    const secret = await partner();
    expect(
      await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'new', 'p1@b'))),
    ).toEqual({ code: '200', body: 'ord_1' });
    // Sent again with the same payloadID, or as a new PO with the same orderID: the same order.
    expect(
      (await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'new', 'p1@b'))))
        .body,
    ).toBe('ord_1');
    expect(
      (await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'new', 'p1b@b'))))
        .body,
    ).toBe('ord_1');
    expect(host.started).toHaveLength(1);

    const updated = await statusText(
      await post('/plugins/punchout/cxml/order', po(secret, 'update', 'p2@b', 7)),
    );
    expect(updated).toEqual({ code: '200', body: 'ord_2' });
    expect(host.cancelled).toEqual([host.started[0]!.key]);
    expect(host.started[1]!.input.lines).toEqual([expect.objectContaining({ qty: 7 })]);
    expect(host.started[1]!.input.meta).toMatchObject({ punchout: { replaces: 'ord_1' } });
    // Resending the update doesn't cancel the order it started.
    await post('/plugins/punchout/cxml/order', po(secret, 'update', 'p2@b', 7));
    expect(host.cancelled).toHaveLength(1);

    expect(
      await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'delete', 'p3@b'))),
    ).toEqual({ code: '200', body: 'ord_2' });
    expect(host.cancelled).toEqual([host.started[0]!.key, host.started[1]!.key]);
  });

  it('refuses to change an order that has already ended, or one it never started', async () => {
    const secret = await partner();
    expect(
      (await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'delete', 'x1@b'))))
        .code,
    ).toBe('404');
    await post('/plugins/punchout/cxml/order', po(secret, 'new', 'n1@b'));
    host.finished.add(host.started[0]!.key);
    const late = await statusText(
      await post('/plugins/punchout/cxml/order', po(secret, 'update', 'u1@b')),
    );
    expect(late.code).toBe('409');
    // Refused before a changed order starts, and the PO stays at its first version.
    expect(host.started).toHaveLength(1);
    expect(host.cancelled).toEqual([]);
    expect((await versions()).map((v) => v.type)).toEqual(['new']);
    expect((await statusText(await send(po(secret, 'delete', 'd1@b')))).code).toBe('409');
    expect((await versions()).map((v) => v.type)).toEqual(['new']);
    expect(
      (await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'clone', 'c1@b'))))
        .code,
    ).toBe('406');
  });

  it('withdraws the changed order when the one it replaces ends after the check', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    host.finishing.add(host.started[0]!.key);
    expect((await statusText(await send(po(secret, 'update', 'u1@b', 7)))).code).toBe('409');
    expect(host.started).toHaveLength(2);
    expect(host.cancelled).toEqual([host.started[1]!.key]);
    expect((await versions()).map((v) => v.type)).toEqual(['new']);
  });

  it('finishes a resent update whose first try started its order and cancelled the one before', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    const partnerId = (await versions())[0]!.key.split(':')[1];
    const key = `cxml:${partnerId}:u1@b`;
    // The first try claimed version 2, started its order and cancelled the first, then stopped.
    await env.DB.prepare(
      "INSERT INTO purchase_orders (key, partner_id, order_ref, version, type, order_id, created_at) VALUES (?, ?, 'PO-7781', 2, 'update', NULL, 0)",
    )
      .bind(key, partnerId)
      .run();
    host.started.push({ key } as never);
    host.cancelled.push(host.started[0]!.key);
    expect(await statusText(await send(po(secret, 'update', 'u1@b', 7)))).toEqual({
      code: '200',
      body: 'ord_2',
    });
    expect(host.started).toHaveLength(2);
    expect((await versions()).map((v) => v.order_id)).toEqual(['ord_1', 'ord_2']);
  });

  it('withdraws a resent update’s order when the one before ended in between', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    const partnerId = (await versions())[0]!.key.split(':')[1];
    const key = `cxml:${partnerId}:u1@b`;
    // The first try started its order and stopped; the order before then completed.
    await env.DB.prepare(
      "INSERT INTO purchase_orders (key, partner_id, order_ref, version, type, order_id, created_at) VALUES (?, ?, 'PO-7781', 2, 'update', NULL, 0)",
    )
      .bind(key, partnerId)
      .run();
    host.started.push({ key } as never);
    host.finished.add(host.started[0]!.key);
    expect((await statusText(await send(po(secret, 'update', 'u1@b', 7)))).code).toBe('409');
    expect(host.cancelled).toEqual([key]);
    expect((await versions()).map((v) => v.type)).toEqual(['new']);
  });

  it('keeps the order running when the core refuses the change', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    const refused = await statusText(
      await send(po(secret, 'update', 'u1@b', 7).replaceAll('currency="USD"', 'currency="XXX"')),
    );
    expect(refused.code).toBe('400');
    expect(host.cancelled).toEqual([]);
    expect(host.started).toHaveLength(1);
    // The refused version was given back, so a corrected change goes through.
    expect(await versions()).toEqual([
      expect.objectContaining({ version: 1, type: 'new', order_id: 'ord_1' }),
    ]);
    expect(await statusText(await send(po(secret, 'update', 'u2@b', 7)))).toEqual({
      code: '200',
      body: 'ord_2',
    });
    expect(host.cancelled).toEqual([host.started[0]!.key]);
  });

  it('keeps a cancelled PO cancelled', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    expect(await statusText(await send(po(secret, 'delete', 'd1@b')))).toEqual({
      code: '200',
      body: 'ord_1',
    });
    expect((await statusText(await send(po(secret, 'update', 'u1@b', 7)))).code).toBe('409');
    expect((await statusText(await send(po(secret, 'new', 'n2@b')))).code).toBe('409');
    // Another delete answers the cancelled order and asks nothing more of the core.
    expect(await statusText(await send(po(secret, 'delete', 'd2@b')))).toEqual({
      code: '200',
      body: 'ord_1',
    });
    expect(host.started).toHaveLength(1);
    expect(host.cancelled).toEqual([host.started[0]!.key]);
    expect((await versions()).map((v) => v.type)).toEqual(['new', 'delete']);
  });

  it('lets one of two changes sent at once act on the version before', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    const answers = await Promise.all([
      send(po(secret, 'update', 'u1@b', 7)).then(statusText),
      send(po(secret, 'update', 'u2@b', 8)).then(statusText),
      send(po(secret, 'delete', 'd1@b')).then(statusText),
    ]);
    // However they interleave, each version is cancelled at most once and one order is left
    // standing unless the last change was the delete.
    expect(new Set(host.cancelled).size).toBe(host.cancelled.length);
    const live = host.started.filter((s) => !host.cancelled.includes(s.key));
    const rows = await versions();
    expect(rows.map((r) => r.version)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.every((r) => r.order_id)).toBe(true);
    expect(live).toHaveLength(rows.at(-1)!.type === 'delete' ? 0 : 1);
    for (const a of answers) expect(['200', '409']).toContain(a.code);
    expect(answers.filter((a) => a.code === '200')).toHaveLength(rows.length - 1);
  });

  it('tells a change to wait while another holds the next version, and finishes its own resend', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    const partnerId = (await versions())[0]!.key.split(':')[1];
    // A change whose first try stopped after claiming its version, before acting on it.
    await env.DB.prepare(
      "INSERT INTO purchase_orders (key, partner_id, order_ref, version, type, order_id, created_at) VALUES (?, ?, 'PO-7781', 2, 'update', NULL, 0)",
    )
      .bind(`cxml:${partnerId}:u1@b`, partnerId)
      .run();
    const other = await statusText(await send(po(secret, 'update', 'u2@b', 8)));
    expect(other.code).toBe('409');
    expect(host.cancelled).toEqual([]);
    // Its own resend acts on it.
    expect(await statusText(await send(po(secret, 'update', 'u1@b', 7)))).toEqual({
      code: '200',
      body: 'ord_2',
    });
    expect(host.cancelled).toEqual([host.started[0]!.key]);
    expect((await versions()).map((v) => v.order_id)).toEqual(['ord_1', 'ord_2']);
  });

  it('refuses a partner another partner’s orderID and changes nothing', async () => {
    const secret = await partner();
    await send(po(secret, 'new', 'n1@b'));
    const otherSecret = await partner({ name: 'Contoso Ariba', identity: 'AN02000000002' });
    const other = (type: string, payload: string) =>
      po(otherSecret, type, payload).replaceAll('AN01000000001', 'AN02000000002');
    expect((await statusText(await send(other('update', 'o1@b')))).code).toBe('404');
    expect((await statusText(await send(other('delete', 'o2@b')))).code).toBe('404');
    expect(host.started).toHaveLength(1);
    expect(host.cancelled).toEqual([]);
    expect((await versions()).map((v) => v.order_id)).toEqual(['ord_1']);
  });
});

describe('OCI punchout', () => {
  /** A priced cart the plugin opened, as the core hands it to `renderReturn`. */
  const ociCart = (id: string): PluginCart => ({
    id,
    title: 'x',
    status: 'locked',
    customerId: null,
    lines: [],
    quote: {
      currency: 'EUR',
      lines: [{ id: 'li_1', sku: 'A-1', title: 'Thing', qty: 2, unitPrice: 3, ships: true }],
      subtotal: 6,
      shipping: 0,
      tax: 0,
      total: 6,
      shippingOptions: [],
      shippingOption: null,
      ships: true,
    },
    orderId: null,
    updatedAt: 0,
    sessionRef: 'x',
  });
  const ociPartner = () =>
    partner({ protocol: 'oci', fromDomain: '', identity: 'sap-user', returnHosts: 'sap.example' });
  const setup = (secret: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      USERNAME: 'sap-user',
      PASSWORD: secret,
      HOOK_URL: 'https://sap.example/sap/bc/hook',
      ...extra,
    });

  it('opens a cart from the setup GET and returns OCI fields', async () => {
    const q = setup(await ociPartner());
    const res = await plugin.fetch(new Request(`https://plugin/plugins/punchout/oci/setup?${q}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/cart/start/cart_1/tok');
    // A form POST works the same.
    const posted = await plugin.fetch(
      new Request('https://plugin/plugins/punchout/oci/setup', { method: 'POST', body: q }),
    );
    expect(posted.status).toBe(302);
    // A POST that isn't a form is refused, not a server error.
    for (const init of [{}, { body: '{"USERNAME":"sap-user"}' }])
      expect(
        (
          await plugin.fetch(
            new Request('https://plugin/plugins/punchout/oci/setup', { method: 'POST', ...init }),
          )
        ).status,
      ).toBe(400);
    q.set('PASSWORD', 'wrong');
    expect(
      (await plugin.fetch(new Request(`https://plugin/plugins/punchout/oci/setup?${q}`))).status,
    ).toBe(401);
    const { fields } = await plugin.renderReturn({ cart: ociCart('cart_1') });
    // SAP sent no control fields: the spec's ~OkCode and ~CALLER, and no ~TARGET.
    expect(fields).toEqual({
      '~OkCode': 'ADDI',
      '~CALLER': 'CTLG',
      'NEW_ITEM-DESCRIPTION[1]': 'Thing',
      'NEW_ITEM-QUANTITY[1]': '2',
      'NEW_ITEM-UNIT[1]': 'EA',
      'NEW_ITEM-PRICE[1]': '3.00',
      'NEW_ITEM-PRICEUNIT[1]': '1',
      'NEW_ITEM-CURRENCY[1]': 'EUR',
      'NEW_ITEM-VENDORMAT[1]': 'A-1',
      'NEW_ITEM-EXT_PRODUCT_ID[1]': 'cart_1:li_1',
    });
  });

  it('echoes the ~OkCode, ~TARGET and ~CALLER the setup sent, GET or POST', async () => {
    const secret = await ociPartner();
    const control = { '~OkCode': 'ADDI', '~TARGET': '_top', '~CALLER': 'CTLG' };
    const got = await plugin.fetch(
      new Request(`https://plugin/plugins/punchout/oci/setup?${setup(secret, control)}`),
    );
    expect(got.status).toBe(302);
    const posted = await plugin.fetch(
      new Request('https://plugin/plugins/punchout/oci/setup', {
        method: 'POST',
        body: setup(secret, { ...control, '~TARGET': 'catalog_frame' }),
      }),
    );
    expect(posted.status).toBe(302);
    expect((await plugin.renderReturn({ cart: ociCart('cart_1') })).fields).toMatchObject(control);
    expect((await plugin.renderReturn({ cart: ociCart('cart_2') })).fields).toMatchObject({
      ...control,
      '~TARGET': 'catalog_frame',
    });
    // Sent again (the buyer's page posts the fields again if it was closed), the same.
    expect((await plugin.renderReturn({ cart: ociCart('cart_1') })).fields).toMatchObject(control);
  });

  it('drops a control value that isn’t a short plain word, and never echoes it', async () => {
    const secret = await ociPartner();
    const res = await plugin.fetch(
      new Request('https://plugin/plugins/punchout/oci/setup', {
        method: 'POST',
        body: setup(secret, {
          '~OkCode': 'ADDI"><script>',
          '~TARGET': 'javascript:alert(1)',
          '~CALLER': 'x'.repeat(200),
        }),
      }),
    );
    expect(res.status).toBe(302);
    const row = await env.DB.prepare('SELECT oci_control FROM sessions WHERE cart_id = ?')
      .bind('cart_1')
      .first<{ oci_control: string }>();
    expect(JSON.parse(row!.oci_control)).toEqual({ okCode: 'ADDI', caller: 'CTLG' });
    const { fields } = await plugin.renderReturn({ cart: ociCart('cart_1') });
    expect(fields['~OkCode']).toBe('ADDI');
    expect(fields['~CALLER']).toBe('CTLG');
    expect(fields).not.toHaveProperty('~TARGET');
    expect(JSON.stringify(fields)).not.toMatch(/script|javascript|xxxx/);
  });

  it('returns a session opened before the control fields were kept with the defaults', async () => {
    const secret = await ociPartner();
    await plugin.fetch(
      new Request(
        `https://plugin/plugins/punchout/oci/setup?${setup(secret, { '~TARGET': '_top' })}`,
      ),
    );
    // As a row written by the code before migration 0003 (or one a later edit left odd) reads.
    for (const stored of [null, '{"okCode":"<b>","target":"_top\\" onload=x"}']) {
      await env.DB.prepare('UPDATE sessions SET oci_control = ? WHERE cart_id = ?')
        .bind(stored, 'cart_1')
        .run();
      const { fields } = await plugin.renderReturn({ cart: ociCart('cart_1') });
      expect(fields['~OkCode']).toBe('ADDI');
      expect(fields['~CALLER']).toBe('CTLG');
      expect(fields).not.toHaveProperty('~TARGET');
    }
  });
});

describe('the admin page', () => {
  it('is for admins, shows a secret once and rotates it', async () => {
    const page = await (await admin('/plugins/punchout/')).text();
    expect(page).toContain('No partners yet');
    const first = await partner();
    const listed = await (await admin('/plugins/punchout/')).text();
    expect(listed).toContain('Northwind Ariba');
    expect(listed).not.toContain(first);
    const id = /partners\/(ptn_[a-z0-9]+)\/rotate/.exec(listed)![1];
    const rotated = await (await admin(`/plugins/punchout/partners/${id}/rotate`, {})).text();
    expect(rotated).toContain('New secret');
    expect(rotated).not.toContain(first);
    expect(secretIn(JSON.parse(rotated))).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The old secret no longer opens a session.
    const res = await post('/plugins/punchout/cxml/setup', setupXml.replace('SECRET', first));
    expect(await status(res)).toBe('401');
  });

  it('names the setup URLs under the deployment’s alias when it has one', async () => {
    expect(await (await admin('/plugins/punchout/')).text()).toContain(
      'https://<your OrderLoop address>/plugins/punchout/cxml/setup',
    );
    const path = '/plugins/punchout/';
    const headers = new Headers({
      'x-orderloop-alias': '/punchout/',
      [PRINCIPAL_HEADER]: await signPrincipal(
        KEY,
        { kind: 'user', id: 'usr_admin', name: 'Admin', role: 'admin' },
        path,
      ),
    });
    const page = await (
      await plugin.fetch(new Request(`https://plugin${path}`, { headers }))
    ).text();
    expect(page).toContain('https://<your OrderLoop address>/punchout/cxml/setup');
    expect(page).toContain('/punchout/oci/setup');
  });

  it('refuses a partner without return hosts', async () => {
    const res = await admin('/plugins/punchout/partners', {
      name: 'X',
      protocol: 'cxml',
      fromDomain: 'NetworkID',
      identity: 'X',
      flowId: 'f',
      returnHosts: '',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('List the host names');
  });
});

describe('the partner self-test and setup notes', () => {
  /** The partner's id, off the admin page's list. */
  async function partnerId(name = 'Northwind Ariba') {
    const view = (await (await admin('/plugins/punchout/')).json()) as PluginView;
    const rows = JSON.stringify(view);
    const at = rows.indexOf(name);
    return /partners\/(ptn_[a-z0-9]+)/.exec(rows.slice(at))![1]!;
  }

  /** The partner's test, as an admin posts it from the page: its checks by label. */
  async function test(id: string) {
    const res = await admin(`/plugins/punchout/partners/${id}/test`, {});
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(checkPluginView(raw).ok).toBe(true);
    const view = JSON.parse(raw) as PluginView;
    type Table = Extract<PluginView['blocks'][number], { type: 'table' }>;
    const section = view.blocks.find(
      (b): b is Extract<typeof b, { type: 'section' }> =>
        b.type === 'section' && b.title === 'Test',
    )!;
    const table = section.blocks.find((b): b is Table => b.type === 'table')!;
    const checks = Object.fromEntries(
      table.rows.map((r) => {
        const result = r.cells.result as { text: string };
        return [
          String(r.cells.check),
          { pass: result.text === 'Pass', detail: String(r.cells.detail) },
        ];
      }),
    );
    return { checks, view, raw };
  }

  /** The text of each code block on the page, in order. */
  const codesIn = (view: PluginView) =>
    view.blocks
      .flatMap((b) => (b.type === 'section' ? b.blocks : [b]))
      .flatMap((b) => (b.type === 'code' ? [b.text] : []));

  /** Changes the stored partner, as no form on the page could. */
  const stored = (id: string, set: string, ...values: unknown[]) =>
    env.DB.prepare(`UPDATE partners SET ${set} WHERE id = ?`)
      .bind(...values, id)
      .run();

  it('passes a partner a session would let in, opening no cart', async () => {
    const secret = await partner();
    const id = await partnerId();
    const { checks, view, raw } = await test(id);
    expect(Object.keys(checks)).toEqual([
      'Partner record',
      'Return hosts',
      'Frame origins',
      'Status',
      'Commerce model',
      'Cart',
      'Flow',
      'Customer',
    ]);
    for (const [label, c] of Object.entries(checks)) expect(c.pass, label).toBe(true);
    expect(JSON.stringify(view.blocks[0])).toContain('All checks pass');
    // The core was asked what it would make of the cart a session opens, and opened nothing.
    expect(host.checked).toHaveLength(1);
    expect(host.checked[0]).toMatchObject({
      flowId: 'tpl-b2b-order',
      customerId: 'cus_northwind',
      returnUrl: 'https://buyer.example/',
      frameOrigins: ['https://buyer.example'],
      idleMs: 120 * 60_000,
    });
    expect(host.opened).toEqual([]);
    expect(host.started).toEqual([]);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{
      n: number;
    }>();
    expect(sessions?.n).toBe(0);
    // Never the secret, nor its hash.
    expect(raw).not.toContain(secret);
    const { hash } = (await env.DB.prepare('SELECT secret_hash AS hash FROM partners').first<{
      hash: string;
    }>())!;
    expect(raw).not.toContain(hash);
  });

  it('fails each check a session or its order would fail', async () => {
    await partner({ flowId: 'flow_nope', customerId: 'cus_nope', model: 'wholesale' });
    const id = await partnerId();
    let { checks, view } = await test(id);
    expect(checks.Flow).toEqual({
      pass: false,
      detail: 'flow_nope: That flow has no published version.',
    });
    expect(checks.Customer).toEqual({ pass: false, detail: 'cus_nope: No such customer.' });
    expect(checks['Commerce model']?.pass).toBe(false);
    expect(JSON.stringify(view.blocks[0])).toContain('3 of 8 checks fail');

    await admin(`/plugins/punchout/partners/${id}/disable`, {});
    expect((await test(id)).checks.Status).toMatchObject({ pass: false });

    // A record the form wouldn't take, as an older version or a hand edit might have left it.
    await stored(
      id,
      "from_domain = '', secret_hash = 'x', return_hosts = ?, frame_origins = ?",
      JSON.stringify(['buyer.example', 'Bad Host', 'evil.example:8443']),
      JSON.stringify(['http://buyer.example', 'https://buyer.example/path', 'https://ok.example']),
    );
    ({ checks } = await test(id));
    expect(checks['Partner record']).toMatchObject({ pass: false });
    expect(checks['Partner record']?.detail).toMatch(/From domain, secret/);
    expect(checks['Return hosts']).toEqual({
      pass: false,
      detail: 'Not host names: Bad Host, evil.example:8443.',
    });
    expect(checks['Frame origins']).toEqual({
      pass: false,
      detail: 'Not https origins: http://buyer.example, https://buyer.example/path.',
    });

    // A return host on the deployment itself, which the core refuses to post a cart back to.
    await stored(id, 'return_hosts = ?', JSON.stringify(['buyer.example', 'app.orderloop.test']));
    host.checked.length = 0;
    ({ checks } = await test(id));
    expect(host.checked.map((c) => c.returnUrl)).toEqual([
      'https://buyer.example/',
      'https://app.orderloop.test/',
    ]);
    expect(checks.Cart).toEqual({
      pass: false,
      detail: 'returnUrl must be the buyer’s system, not this one',
    });
    // Still asked about the flow by the host that would open a cart.
    expect(checks.Flow).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/^flow_nope:/),
    });
    // Every host the deployment's own: the flow and customer go unchecked, and fail.
    await stored(id, 'return_hosts = ?', JSON.stringify(['app.orderloop.test']));
    ({ checks } = await test(id));
    expect(checks.Flow).toEqual({
      pass: false,
      detail: 'Not checked: OrderLoop wouldn’t open the cart (see Cart).',
    });
    expect(checks.Customer?.pass).toBe(false);
    // Once per distinct host, and no more than ten.
    const many = Array.from({ length: 12 }, (_, i) => `h${i}.buyer.example`);
    await stored(
      id,
      'return_hosts = ?',
      JSON.stringify(['buyer.example', 'buyer.example', ...many]),
    );
    host.checked.length = 0;
    ({ checks } = await test(id));
    expect(host.checked.map((c) => c.returnUrl)).toEqual([
      'https://buyer.example/',
      ...many.slice(0, 9).map((h) => `https://${h}/`),
    ]);
    expect(checks.Cart?.detail).toMatch(/the first 10; 3 more not asked/);
    // No return host: nothing for the core to check.
    await stored(id, "return_hosts = '[]'");
    host.checked.length = 0;
    ({ checks } = await test(id));
    expect(host.checked).toEqual([]);
    expect(checks.Flow?.detail).toMatch(/no usable return host/);
    expect(host.opened).toEqual([]);
  });

  it('says so when the core can’t be asked, without its error', async () => {
    await partner();
    const id = await partnerId();
    host.checks = 'refused';
    let { checks } = await test(id);
    for (const label of ['Cart', 'Flow', 'Customer'])
      expect(checks[label]?.detail).toMatch(/doesn’t let Punchout open carts/);
    host.checks = 'down';
    const down = await test(id);
    expect(down.checks.Flow?.detail).toMatch(/couldn’t be reached/);
    expect(down.raw).not.toContain('D1_ERROR');
    // With no host API bound at all.
    plugin = new PunchoutPlugin(ctx, { ...env, ORDERLOOP: undefined } as never);
    ({ checks } = await test(id));
    expect(checks.Customer?.detail).toMatch(/doesn’t let Punchout open carts/);
    expect(host.opened).toEqual([]);
  });

  it('is an admin’s POST, as rotating a secret is', async () => {
    await partner();
    const id = await partnerId();
    const path = `/plugins/punchout/partners/${id}/test`;
    const as = async (role: string, method: string, signedFor = path) =>
      (
        await plugin.fetch(
          new Request(`https://plugin${path}`, {
            method,
            headers: {
              [PRINCIPAL_HEADER]: await signPrincipal(
                KEY,
                { kind: 'user', id: 'usr_1', name: 'Ada', role: role as 'operator' },
                signedFor,
              ),
            },
          }),
        )
      ).status;
    const unsigned = (method: string, to = path) =>
      plugin.fetch(new Request(`https://plugin${to}`, { method })).then((r) => r.status);
    const rotate = `/plugins/punchout/partners/${id}/rotate`;
    // The same answers as rotate: no principal, one signed for another path, a role below admin.
    expect(await unsigned('POST')).toBe(await unsigned('POST', rotate));
    expect(await unsigned('POST')).toBe(401);
    expect(await as('admin', 'POST', '/plugins/punchout/')).toBe(401);
    expect(await as('operator', 'POST')).toBe(403);
    expect(await as('admin', 'POST')).toBe(200);
    // A test is posted; a GET of it is nothing.
    expect(await as('admin', 'GET')).toBe(404);
    expect(host.checked).toHaveLength(1);
    // An id with no partner says so on the page.
    const gone = await admin('/plugins/punchout/partners/ptn_0000000000000000/test', {});
    expect(gone.status).toBe(400);
    expect(await gone.text()).toContain('That partner no longer exists');
  });

  it('gives a cXML partner’s admin its URLs, credentials and a request that opens a session', async () => {
    const secret = await partner();
    const id = await partnerId();
    const path = `/plugins/punchout/partners/${id}`;
    const res = await plugin.fetch(
      new Request(`https://plugin${path}`, {
        headers: {
          'x-orderloop-origin': 'https://shop.example',
          'x-orderloop-alias': '/punchout/',
          [PRINCIPAL_HEADER]: await signPrincipal(
            KEY,
            { kind: 'user', id: 'usr_admin', name: 'Admin', role: 'admin' },
            path,
          ),
        },
      }),
    );
    const raw = await res.text();
    expect(checkPluginView(raw).ok).toBe(true);
    expect(raw).not.toContain(secret);
    expect(raw).toContain('Setup URL: https://shop.example/punchout/cxml/setup');
    expect(raw).toContain('Order URL: https://shop.example/punchout/cxml/order');
    expect(raw).toContain('From (their credential): domain NetworkID, identity AN01000000001');
    expect(raw).toContain('domain NetworkID, identity orderloop');
    expect(raw).toContain(`partners/${id}/test`);
    const view = JSON.parse(raw) as PluginView;
    const codes = codesIn(view);
    const sample = codes.find((c) => c.includes('PunchOutSetupRequest'))!;
    expect(sample).toContain('<SharedSecret>SECRET</SharedSecret>');
    expect(codes.find((c) => c.startsWith('curl'))).toBe(
      "curl -sS -H 'Content-Type: text/xml' --data-binary @setup.xml 'https://shop.example/punchout/cxml/setup'",
    );
    // The sample, with the secret in place, is a request the plugin lets in.
    const opened = await post('/plugins/punchout/cxml/setup', sample.replace('SECRET', secret));
    expect(await status(opened)).toBe('200');
    expect(host.opened[0]).toMatchObject({ returnUrl: 'https://buyer.example/' });
  });

  it('gives an OCI partner’s admin its catalog call, and names no secret', async () => {
    const secret = await partner({
      name: 'Contoso SAP',
      protocol: 'oci',
      identity: "sap-user's",
      fromDomain: '',
    });
    const id = await partnerId('Contoso SAP');
    const raw = await (await admin(`/plugins/punchout/partners/${id}`)).text();
    expect(checkPluginView(raw).ok).toBe(true);
    expect(raw).not.toContain(secret);
    // No origin forwarded: the placeholder, as the list shows it.
    expect(raw).toContain(
      'Catalog URL: https://<your OrderLoop address>/plugins/punchout/oci/setup',
    );
    expect(raw).toContain('USERNAME: sap-user');
    expect(raw).toContain('Without them it sends ~OkCode=ADDI and ~CALLER=CTLG, and no ~TARGET.');
    expect(raw).not.toContain('cxml/order');
    const view = JSON.parse(raw) as PluginView;
    const texts = codesIn(view);
    expect(texts[0]).toBe("USERNAME=sap-user's\nPASSWORD=SECRET\nHOOK_URL=https://buyer.example/");
    // Quoted for the shell, whatever the USERNAME holds.
    expect(texts[1]).toContain(`--data-urlencode 'USERNAME=sap-user'\\''s'`);
    // The parameters, with the secret in place, open a session.
    const q = new URLSearchParams(
      Object.fromEntries(texts[0]!.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2))),
    );
    q.set('PASSWORD', secret);
    const res = await plugin.fetch(
      new Request('https://plugin/plugins/punchout/oci/setup', { method: 'POST', body: q }),
    );
    expect(res.status).toBe(302);
    // Its test checks the same, and OCI needs no From domain.
    expect((await test(id)).checks['Partner record']).toMatchObject({ pass: true });
  });
});

it('keeps the plugin contract', async () => {
  expect(
    await pluginContract(plugin, {
      effects: async () => 0,
      deliveries: async () => 0,
      principalKey: KEY,
    }),
  ).toEqual([]);
});
