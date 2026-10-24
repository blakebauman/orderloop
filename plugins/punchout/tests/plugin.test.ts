import { env } from 'cloudflare:workers';
import {
  type ExternalCartInput,
  type PluginCart,
  type PluginStartOrder,
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
    async getCart() {
      return null;
    },
    cancelled: [] as string[],
    finished: new Set<string>(),
    async startOrder(req: PluginStartOrder) {
      started.push(req);
      return { ok: true as const, orderId: `ord_${started.length}`, replayed: false };
    },
    async cancelOrder(req: { key: string; reason: string }) {
      const i = started.findIndex((s) => s.key === req.key);
      if (i < 0) return { ok: false as const, error: 'No order was started under that key.' };
      if (this.finished.has(req.key))
        return { ok: true as const, orderId: `ord_${i + 1}`, outcome: 'finished' as const };
      this.cancelled.push(req.key);
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
  const html = await res.text();
  const secret = /<strong>([A-Za-z0-9_-]{20,})<\/strong>/.exec(html)?.[1];
  if (!secret) throw new Error(`no secret on the page: ${html.slice(0, 400)}`);
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
    expect(host.started).toHaveLength(1);
    expect(
      (await statusText(await post('/plugins/punchout/cxml/order', po(secret, 'clone', 'c1@b'))))
        .code,
    ).toBe('406');
  });
});

describe('OCI punchout', () => {
  it('opens a cart from the setup GET and returns OCI fields', async () => {
    const secret = await partner({
      protocol: 'oci',
      fromDomain: '',
      identity: 'sap-user',
      returnHosts: 'sap.example',
    });
    const q = new URLSearchParams({
      USERNAME: 'sap-user',
      PASSWORD: secret,
      HOOK_URL: 'https://sap.example/sap/bc/hook',
    });
    const res = await plugin.fetch(new Request(`https://plugin/plugins/punchout/oci/setup?${q}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/cart/start/cart_1/tok');
    // A form POST works the same.
    const posted = await plugin.fetch(
      new Request('https://plugin/plugins/punchout/oci/setup', { method: 'POST', body: q }),
    );
    expect(posted.status).toBe(302);
    q.set('PASSWORD', 'wrong');
    expect(
      (await plugin.fetch(new Request(`https://plugin/plugins/punchout/oci/setup?${q}`))).status,
    ).toBe(401);
    const { fields } = await plugin.renderReturn({
      cart: {
        id: 'cart_1',
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
      },
    });
    expect(fields).toMatchObject({
      'NEW_ITEM-VENDORMAT[1]': 'A-1',
      'NEW_ITEM-QUANTITY[1]': '2',
      'NEW_ITEM-PRICE[1]': '3.00',
      'NEW_ITEM-CURRENCY[1]': 'EUR',
    });
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
    // The old secret no longer opens a session.
    const res = await post('/plugins/punchout/cxml/setup', setupXml.replace('SECRET', first));
    expect(await status(res)).toBe('401');
  });

  it('names the setup URLs under the deployment’s alias when it has one', async () => {
    expect(await (await admin('/plugins/punchout/')).text()).toContain(
      'https://&#60;your OrderLoop address&#62;/plugins/punchout/cxml/setup',
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
    expect(page).toContain('https://&#60;your OrderLoop address&#62;/punchout/cxml/setup');
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
    expect(await res.text()).toContain('List the host names');
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
