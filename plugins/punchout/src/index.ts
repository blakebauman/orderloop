/**
 * Punchout: buyers shop from inside their procurement system (Ariba, Coupa, SAP and others).
 *
 * - cXML: the system posts a PunchOutSetupRequest to `/plugins/punchout/cxml/setup`; the plugin
 *   finds the partner by its From credential, checks the Sender's SharedSecret and that the
 *   BrowserFormPost URL is one of the partner's hosts, opens an external cart through the core
 *   (`openExternalCart`) and answers the cart's start link as the StartPage. When the buyer sends
 *   the cart back, `renderReturn` gives the PunchOutOrderMessage the core posts to BrowserFormPost.
 *   The PO then arrives as an OrderRequest at `/plugins/punchout/cxml/order`, which starts the
 *   order once per payload id (`startOrder`).
 * - OCI: the system opens `/plugins/punchout/oci/setup?USERNAME=…&PASSWORD=…&HOOK_URL=…`; the
 *   cart goes back to HOOK_URL as OCI fields.
 *
 * Partners and their secrets are kept here (src/partners.ts) and managed on the plugin's admin page.
 */

import type { PluginCart } from '@orderloop/core';
import { definePlugin, host, pluginDb } from '@orderloop/plugin-sdk';
import {
  CxmlError,
  orderMessage,
  parseOrderRequest,
  parseSetupRequest,
  setupResponse,
  statusResponse,
} from './cxml';
import manifest from './manifest';
import { ociFields, parseOciSetup } from './oci';
import { adminPages } from './pages';
import {
  findPartner,
  getPartner,
  type Partner,
  recordSession,
  returnAllowed,
  secretMatches,
  sessionOf,
} from './partners';
import { XmlError } from './xml';

const HOST = 'orderloop';
const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/xml; charset=UTF-8' } });
// cXML answers every request it could read with HTTP 200 and its own Status code: procurement
// networks take any other HTTP status for a transport failure, and retry.
const refuse = (status: number, text: string) => xml(statusResponse(HOST, status, text));

/** The buyer, as the procurement system names them in its Extrinsics. */
function buyerOf(extrinsics: Record<string, string>, fallback: string) {
  const email = extrinsics.UserEmail || extrinsics.Email;
  const id = email || extrinsics.UniqueName || extrinsics.UserId || fallback;
  const name = extrinsics.UserFullName || extrinsics.UserPrintableName || email || id;
  return { id: id.slice(0, 200), name: name.slice(0, 120) };
}

async function openCart(
  env: Env,
  p: Partner,
  s: {
    sessionRef: string;
    buyer: { id: string; name: string };
    returnUrl: string;
    lines?: { sku: string; qty: number }[];
  },
) {
  return host(env).openExternalCart({
    sessionRef: s.sessionRef,
    title: `${p.name} punchout`,
    flowId: p.flowId,
    customerId: p.customerId,
    buyer: s.buyer,
    returnUrl: s.returnUrl,
    frameOrigins: p.frameOrigins,
    expiresAt: Date.now() + Math.min(p.sessionMinutes, 24 * 60) * 60_000,
    ...(s.lines?.length ? { lines: s.lines } : {}),
  });
}

async function cxmlSetup(request: Request, env: Env): Promise<Response> {
  let req: ReturnType<typeof parseSetupRequest>;
  try {
    req = parseSetupRequest(await request.text());
  } catch (err) {
    if (err instanceof XmlError || err instanceof CxmlError) return refuse(400, err.message);
    throw err;
  }
  const partner = await findPartner(env, 'cxml', req.from);
  if (!partner || !(await secretMatches(partner, req.sharedSecret)))
    return refuse(401, 'Unknown buyer or wrong shared secret');
  if (!returnAllowed(partner, req.browserFormPost))
    return refuse(403, 'BrowserFormPost is not one of this buyer’s hosts');
  const lines = req.items.filter((i) => i.sku).map(({ sku, qty }) => ({ sku, qty }));
  const session = {
    buyer: buyerOf(req.extrinsics, req.buyerCookie),
    returnUrl: req.browserFormPost,
    lines: req.operation === 'create' ? [] : lines,
  };
  // The same BuyerCookie finds the cart it opened; once that cart has gone back (an `edit` of a
  // returned cart reuses the cookie on some systems), this request opens a new one.
  let opened = await openCart(env, partner, {
    sessionRef: `${partner.id}:${req.buyerCookie}`.slice(0, 200),
    ...session,
  });
  if (!opened.ok && /^That session’s cart (is|has)/.test(opened.error))
    opened = await openCart(env, partner, {
      sessionRef: `${partner.id}:${req.buyerCookie}:${req.payloadId || crypto.randomUUID()}`.slice(
        0,
        200,
      ),
      ...session,
    });
  if (!opened.ok) return refuse(400, opened.error);
  if (!opened.cart.startUrl) return refuse(500, 'The app’s origin is not configured');
  await recordSession(env, {
    cartId: opened.cart.cartId,
    partnerId: partner.id,
    buyerCookie: req.buyerCookie,
    operation: req.operation,
  });
  return xml(setupResponse(HOST, opened.cart.startUrl));
}

async function cxmlOrder(request: Request, env: Env): Promise<Response> {
  let po: ReturnType<typeof parseOrderRequest>;
  try {
    po = parseOrderRequest(await request.text());
  } catch (err) {
    if (err instanceof XmlError || err instanceof CxmlError) return refuse(400, err.message);
    throw err;
  }
  const partner = await findPartner(env, 'cxml', po.from);
  if (!partner || !(await secretMatches(partner, po.sharedSecret)))
    return refuse(401, 'Unknown buyer or wrong shared secret');
  if (!['new', 'update', 'delete'].includes(po.type))
    return refuse(406, `Order type “${po.type}” is not supported`);
  if (!po.payloadId) return refuse(400, 'The order has no payloadID');
  const key = `cxml:${partner.id}:${po.payloadId}`.slice(0, 200);
  const db = pluginDb(env);
  // A document sent again: answer as the first time, change nothing.
  const seen = await db
    .prepare('SELECT order_id FROM purchase_orders WHERE key = ?')
    .bind(key)
    .first<{ order_id: string | null }>();
  if (seen) return xml(statusResponse(HOST, 200, 'OK', seen.order_id ?? ''));
  // The version before this one (an update or delete names the same orderID).
  const before = await db
    .prepare(
      'SELECT key, order_id FROM purchase_orders WHERE partner_id = ? AND order_ref = ? ORDER BY created_at DESC LIMIT 1',
    )
    .bind(partner.id, po.orderId)
    .first<{ key: string; order_id: string | null }>();
  const record = (orderId: string | null) =>
    db
      .prepare(
        'INSERT INTO purchase_orders (key, partner_id, order_ref, type, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .bind(key, partner.id, po.orderId, po.type, orderId, Date.now())
      .run();

  // A `new` for an order already started (sent again under a new payloadID): that order.
  if (po.type === 'new' && before?.order_id)
    return xml(statusResponse(HOST, 200, 'OK', before.order_id));
  if (po.type !== 'new') {
    if (!before?.order_id)
      return po.type === 'delete'
        ? refuse(404, `No order ${po.orderId} to cancel`)
        : refuse(404, `No order ${po.orderId} to update`);
    const cancelled = await host(env).cancelOrder({
      key: before.key,
      reason: `Purchase order ${po.orderId} ${po.type === 'delete' ? 'cancelled' : 'changed'} by the buyer`,
    });
    if (!cancelled.ok) return refuse(500, cancelled.error);
    if (cancelled.outcome === 'finished')
      return refuse(
        409,
        `Order ${po.orderId} can't be ${po.type === 'delete' ? 'cancelled' : 'changed'}: it has already ended`,
      );
    if (po.type === 'delete') {
      await record(cancelled.orderId);
      return xml(statusResponse(HOST, 200, 'OK', cancelled.orderId));
    }
  }

  // Which carts the PO came from, by the SupplierPartAuxiliaryID each returned line carried.
  const carts = [
    ...new Set(po.items.map((i) => i.aux?.split(':')[0]).filter((c) => c?.startsWith('cart_'))),
  ];
  const contact =
    po.shipTo?.email && /^[^\s@]+@[^\s@]+$/.test(po.shipTo.email)
      ? {
          email: po.shipTo.email,
          ...(po.shipTo.name ? { name: po.shipTo.name } : {}),
          ...(po.shipTo.phone ? { phone: po.shipTo.phone } : {}),
        }
      : undefined;
  const started = await host(env).startOrder({
    key,
    flowId: partner.flowId,
    input: {
      model: partner.model as 'b2b',
      channel: 'edi',
      externalId: po.orderId,
      title: `PO ${po.orderId}`,
      ...(partner.customerId ? { customerId: partner.customerId } : {}),
      currency: po.currency,
      lines: po.items.map((i) => ({
        sku: i.sku,
        qty: i.qty,
        ...(i.description ? { name: i.description } : {}),
      })),
      ...(contact ? { contact } : {}),
      meta: {
        ...(po.shipTo ? { shipTo: po.shipTo } : {}),
        punchout: {
          partnerId: partner.id,
          orderId: po.orderId,
          carts,
          ...(po.type === 'update' && before?.order_id ? { replaces: before.order_id } : {}),
        },
      },
    },
  });
  if (!started.ok) return refuse(400, started.error);
  await record(started.orderId);
  return xml(statusResponse(HOST, 200, 'OK', started.orderId));
}

async function ociSetup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // SAP opens the catalog with GET or a form POST; either way the same fields.
  const params = new URLSearchParams(url.searchParams);
  if (request.method === 'POST')
    for (const [k, v] of await request.formData()) if (typeof v === 'string') params.set(k, v);
  const setup = parseOciSetup(params);
  const page = (status: number, body: string, head = '') =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">${head}<title>Punchout</title></head><body>${body}</body></html>`,
      {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      },
    );
  if (!setup) return page(400, '<p>USERNAME, PASSWORD and HOOK_URL are required.</p>');
  const partner = await findPartner(env, 'oci', [{ domain: '', identity: setup.username }]);
  if (!partner || !(await secretMatches(partner, setup.password)))
    return page(401, '<p>Unknown user or wrong password.</p>');
  if (!returnAllowed(partner, setup.hookUrl))
    return page(403, '<p>HOOK_URL is not one of this buyer’s hosts.</p>');
  const opened = await openCart(env, partner, {
    sessionRef: `${partner.id}:oci:${crypto.randomUUID()}`,
    buyer: { id: setup.username, name: setup.username },
    returnUrl: setup.hookUrl,
  });
  if (!opened.ok) return page(400, `<p>${escapeHtml(opened.error)}</p>`);
  await recordSession(env, {
    cartId: opened.cart.cartId,
    partnerId: partner.id,
    buyerCookie: '',
    operation: 'create',
  });
  // To the cart's start link: the one place off its own pages a plugin may redirect, so a system
  // that frames the catalog lands on the cart's page, which the partner's frame origins may frame.
  return new Response(null, {
    status: 302,
    headers: { location: opened.cart.startPath, 'cache-control': 'no-store' },
  });
}

const escapeHtml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The cart's lines as priced, with a reference back to the cart line. */
function priced(cart: PluginCart) {
  const q = cart.quote;
  if (!q) throw new Error('The cart has no price');
  return {
    currency: q.currency,
    total: q.subtotal,
    lines: q.lines.map((l) => ({
      qty: l.qty,
      sku: l.sku,
      aux: `${cart.id}:${l.id}`,
      unitPrice: l.unitPrice,
      description: l.title,
    })),
  };
}

export default definePlugin<Env>({
  manifest,

  async renderReturn({ cart }, env) {
    const session = await sessionOf(env, cart.id);
    const partner = session ? await getPartner(env, session.partner_id) : null;
    if (!session || !partner) throw new Error(`No punchout session for ${cart.id}`);
    const p = priced(cart);
    if (partner.protocol === 'oci')
      return {
        fields: ociFields(
          p.lines.map((l) => ({
            sku: l.sku,
            description: l.description,
            qty: l.qty,
            unitPrice: l.unitPrice,
            currency: p.currency,
            ref: l.aux,
          })),
        ),
      };
    return {
      fields: {
        'cxml-urlencoded': orderMessage({
          host: HOST,
          from: { domain: partner.supplierDomain, identity: partner.supplierIdentity },
          to: { domain: partner.fromDomain, identity: partner.identity },
          buyerCookie: session.buyer_cookie,
          currency: p.currency,
          total: p.total,
          lines: p.lines,
        }),
      },
    };
  },

  async pages(request, { env, principal }) {
    const path = new URL(request.url).pathname;
    if (path === '/plugins/punchout/cxml/setup' && request.method === 'POST')
      return cxmlSetup(request, env);
    if (path === '/plugins/punchout/cxml/order' && request.method === 'POST')
      return cxmlOrder(request, env);
    if (
      path === '/plugins/punchout/oci/setup' &&
      (request.method === 'GET' || request.method === 'POST')
    )
      return ociSetup(request, env);
    if (!principal) return new Response('Not found', { status: 404 });
    return adminPages(request, env);
  },
});
