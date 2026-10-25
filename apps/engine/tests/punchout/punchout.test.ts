/**
 * The punchout plugin end to end, sandboxed, against the real host API: a procurement system's
 * PunchOutSetupRequest opens an external cart, its buyer redeems the start link and edits the cart
 * on its socket, sends it back as a PunchOutOrderMessage, and the PO arrives as an OrderRequest
 * that starts one order.
 */

import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { PRINCIPAL_HEADER, pluginKey, signCartGuest, signPrincipal } from '@orderloop/core';
import { createDb, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import orderXml from '../../../../plugins/punchout/tests/fixtures/order-request.xml?raw';
import setupXml from '../../../../plugins/punchout/tests/fixtures/setup-request.xml?raw';
import { EngineApi } from '../../src/api';
import { ensureTemplates } from '../../src/flows';
import worker from '../../src/index';

type Bundles = Record<string, { sha: string; body: string }>;
const bundles = JSON.parse((env as unknown as { TEST_BUNDLES: string }).TEST_BUNDLES) as Bundles;
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const key = () => (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!;

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

beforeAll(async () => {
  for (const [id, b] of Object.entries(bundles))
    await env.DOCS.put(`plugins/${id}/${b.sha}.json`, b.body);
  await ensureTemplates(env);
});

/** A request to the plugin's pages as the web app forwards it (signed for an admin, or public). */
async function plugin(path: string, init: RequestInit = {}, asAdmin = false) {
  const headers = new Headers(init.headers);
  if (asAdmin)
    headers.set(
      PRINCIPAL_HEADER,
      await signPrincipal(
        await pluginKey(key(), 'punchout'),
        { kind: 'user', id: 'usr_admin', name: 'Admin', role: 'admin' },
        path,
      ),
    );
  return api().pluginFetch('punchout', new Request(`https://plugin${path}`, { ...init, headers }));
}

async function addPartner() {
  const res = await plugin(
    '/plugins/punchout/partners',
    {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Northwind Ariba',
        protocol: 'cxml',
        fromDomain: 'NetworkID',
        identity: 'AN01000000001',
        customerId: 'cus_northwind',
        flowId: 'tpl-b2b-order',
        returnHosts: 'buyer.example',
      }),
    },
    true,
  );
  const page = await res.text();
  let secret = /<strong>([A-Za-z0-9_-]{20,})<\/strong>/.exec(page)?.[1];
  // Added by an earlier test (the plugin's storage lasts the file): rotate its secret instead.
  if (!secret) {
    const id = /partners\/(ptn_[a-z0-9]+)\/rotate/.exec(page)?.[1];
    const rotated = await plugin(
      `/plugins/punchout/partners/${id}/rotate`,
      { method: 'POST' },
      true,
    );
    secret = /<strong>([A-Za-z0-9_-]{20,})<\/strong>/.exec(await rotated.text())?.[1];
  }
  if (!secret) throw new Error('no secret');
  return secret;
}

/** The cart's socket as its buyer, as the web app signs it after the start link. */
async function guestSocket(cartId: string, guest: { cartId: string; id: string; name: string }) {
  const path = `/agents/cart-agent/${cartId}`;
  const res = await worker.fetch(
    new Request(`http://engine${path}`, {
      headers: {
        Upgrade: 'websocket',
        [PRINCIPAL_HEADER]: await signCartGuest(key(), guest, path),
      },
    }),
    env,
  );
  const ws = res.webSocket!;
  ws.accept();
  const pending = new Map<string, (m: { result?: unknown }) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'rpc' && pending.has(m.id)) pending.get(m.id)!(m);
  });
  let n = 0;
  return <T>(method: string, args: unknown[] = []) =>
    new Promise<T>((resolve) => {
      const id = `c${++n}`;
      pending.set(id, (m) => resolve(m.result as T));
      ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
    });
}

describe('punchout, end to end', () => {
  it('opens a cart from a setup request, returns it to the buyer and starts their PO', async () => {
    const secret = await addPartner();

    // 1. The procurement system asks for a session.
    const setup = await plugin('/plugins/punchout/cxml/setup', {
      method: 'POST',
      body: setupXml.replace('SECRET', secret),
    });
    expect(setup.status).toBe(200);
    const startUrl = /<URL>([^<]+)<\/URL>/.exec(await setup.text())![1]!;
    const [, cartId, token] = /\/cart\/start\/(cart_[a-z0-9]+)\/([0-9a-f]+)$/.exec(startUrl)!;
    expect(startUrl.startsWith('https://app.orderloop.test/cart/start/')).toBe(true);

    // 2. The buyer's browser opens the start page; the web app redeems it once.
    const redeemed = await api().redeemCartStart(cartId!, token!);
    expect(redeemed?.guest).toMatchObject({ cartId, name: 'Ann & Co. Buyer' });
    expect(await api().redeemCartStart(cartId!, token!)).toBeNull();

    // 3. They fill the cart, priced at Northwind's contract price, and send it back.
    const call = await guestSocket(cartId!, redeemed!.guest);
    expect(await call('apply', [{ op: 'add', sku: 'WID-100', qty: 5 }])).toEqual({ ok: true });
    const sent = await call<{ ok: true; url: string; fields: Record<string, string> }>('transfer');
    expect(sent.ok).toBe(true);
    expect(sent.url).toBe('https://buyer.example/punchout/return?session=1&x=2');
    const message = sent.fields['cxml-urlencoded']!;
    expect(message).toContain('<BuyerCookie>34234234ADFSDF234234</BuyerCookie>');
    expect(message).toContain(`<SupplierPartAuxiliaryID>${cartId}:li_1</SupplierPartAuxiliaryID>`);
    expect(message).toContain('<Money currency="USD">21.50</Money>');
    expect((await api().cartSnapshot(cartId!))?.cart?.status).toBe('returned');

    // 4. Their system sends the PO; it starts one order, however often it is sent.
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const po = orderXml.replace('SECRET', secret).replace('CARTID', cartId!);
    const first = await plugin('/plugins/punchout/cxml/order', { method: 'POST', body: po });
    expect(first.status).toBe(200);
    const orderId = /<Status code="200" text="OK">(ord_[^<]+)<\/Status>/.exec(
      await first.text(),
    )![1];
    const again = await plugin('/plugins/punchout/cxml/order', { method: 'POST', body: po });
    expect(await again.text()).toContain(`>${orderId}</Status>`);
    const row = await createDb(env.DB).select().from(orders).where(eq(orders.id, orderId!)).get();
    expect(row).toMatchObject({
      flowId: 'tpl-b2b-order',
      customerId: 'cus_northwind',
      externalId: 'PO-7781',
      channel: 'edi',
      startedBy: 'plugin:punchout',
    });
  });
});

describe('a purchase order changed or cancelled by the buyer', () => {
  it('cancels the order a delete names, and replaces it on an update', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const secret = await addPartner();
    const doc = (type: string, payload: string, orderID: string) =>
      orderXml
        .replace('SECRET', secret)
        .replace('type="new"', `type="${type}"`)
        .replace('payloadID="1729770000.9876@buyer.example"', `payloadID="${payload}"`)
        .replaceAll('PO-7781', orderID)
        .replace('CARTID', 'cart_none');
    const orderId = async (res: Response) =>
      /<Status code="200" text="OK">(ord_[^<]+)<\/Status>/.exec(await res.text())?.[1];
    const ref = `PO-${crypto.randomUUID().slice(0, 6)}`;
    const send = (type: string, payload: string) =>
      plugin('/plugins/punchout/cxml/order', { method: 'POST', body: doc(type, payload, ref) });
    const first = await orderId(await send('new', `${ref}-1@b`));
    const second = await orderId(await send('update', `${ref}-2@b`));
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    const db = createDb(env.DB);
    expect((await db.select().from(orders).where(eq(orders.id, first!)).get())?.status).toBe(
      'cancelled',
    );
    expect(await orderId(await send('delete', `${ref}-3@b`))).toBe(second);
    expect((await db.select().from(orders).where(eq(orders.id, second!)).get())?.status).toBe(
      'cancelled',
    );
  });
});
