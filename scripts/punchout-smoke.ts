/**
 * A punchout smoke test against a deployment (or a local dev server), as a buyer's procurement
 * system would talk to it: a wrong secret refused, a cXML setup opening a cart whose start link
 * works once, then a PO's life: new, resent, updated, deleted, and an update after the delete
 * refused. See docs/plugins.md, "Punchout".
 *
 *   PUNCHOUT_SECRET=… PUNCHOUT_IDENTITY=AN01… PUNCHOUT_RETURN_URL=https://<a return host>/… \
 *   PUNCHOUT_SKU=<a sku> node scripts/punchout-smoke.ts <deployment id | http://localhost:5173>
 *
 * Add a cXML partner for this in the deployment's Punchout page first, with a customer and flow
 * whose orders may be started and cancelled (each run starts two orders and cancels both), and
 * disable it afterwards. Optional: PUNCHOUT_DOMAIN (the partner's From domain, default NetworkID).
 * Sending the cart back to the buyer's system needs a browser: open the start page it prints a
 * cart id for, from the buyer's side, and use "Return cart to your system".
 *
 * It prints order ids and the cart id, never the secret or the start link's token.
 */

import { loadDeployments } from './fleet.ts';

const env = process.env;
const [target] = process.argv.slice(2);

/** The deployment's address and the path its punchout answers on (its alias, if it has one). */
function where(t: string): { origin: string; base: string } {
  if (/^https?:\/\//.test(t)) return { origin: new URL(t).origin, base: '/punchout/' };
  const d = loadDeployments().find((x) => x.id === t);
  if (!d) throw new Error(`no deployment ${JSON.stringify(t)} in deployments/`);
  if (!d.plugins.punchout) throw new Error(`${d.id} doesn't install punchout`);
  return { origin: `https://${d.domain}`, base: d.plugins.punchout.alias ?? '/plugins/punchout/' };
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function header(identity: string, domain: string, secret: string) {
  const cred = `<Credential domain="${esc(domain)}"><Identity>${esc(identity)}</Identity></Credential>`;
  return `<Header><From>${cred}</From><To><Credential domain="NetworkID"><Identity>orderloop</Identity></Credential></To><Sender><Credential domain="${esc(domain)}"><Identity>${esc(identity)}</Identity><SharedSecret>${esc(secret)}</SharedSecret></Credential><UserAgent>orderloop punchout-smoke</UserAgent></Sender></Header>`;
}

const doc = (payloadId: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><cXML payloadID="${esc(payloadId)}" timestamp="${new Date().toISOString()}" xml:lang="en-US">${body}</cXML>`;

function setup(h: string, returnUrl: string, cookie: string) {
  return `${h}<Request deploymentMode="test"><PunchOutSetupRequest operation="create"><BuyerCookie>${esc(cookie)}</BuyerCookie><Extrinsic name="UserEmail">smoke@orderloop.test</Extrinsic><Extrinsic name="UserFullName">Punchout smoke test</Extrinsic><BrowserFormPost><URL>${esc(returnUrl)}</URL></BrowserFormPost></PunchOutSetupRequest></Request>`;
}

function order(h: string, po: string, type: string, sku: string, qty: number) {
  return `${h}<Request deploymentMode="test"><OrderRequest><OrderRequestHeader orderID="${esc(po)}" orderDate="${new Date().toISOString()}" type="${type}"></OrderRequestHeader><ItemOut quantity="${qty}" lineNumber="1"><ItemID><SupplierPartID>${esc(sku)}</SupplierPartID></ItemID><ItemDetail><UnitOfMeasure>EA</UnitOfMeasure><Description xml:lang="en">${esc(sku)}</Description></ItemDetail></ItemOut></OrderRequest></Request>`;
}

/** A cXML answer's status code, its text, and the order id it carried (the Status element's body). */
function status(xml: string) {
  const m = /<Status\s+code="(\d+)"(?:\s+text="([^"]*)")?\s*(?:\/>|>([^<]*)<\/Status>)/.exec(xml);
  return { code: Number(m?.[1] ?? 0), text: m?.[2] ?? '', body: (m?.[3] ?? '').trim() };
}

let failed = 0;
function check(ok: boolean, what: string, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

try {
  if (!target) throw new Error('usage: punchout-smoke.ts <deployment id | http://localhost:5173>');
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} not set (see the header of scripts/punchout-smoke.ts)`);
    return v;
  };
  const secret = need('PUNCHOUT_SECRET');
  const identity = need('PUNCHOUT_IDENTITY');
  const returnUrl = need('PUNCHOUT_RETURN_URL');
  const sku = need('PUNCHOUT_SKU');
  const domain = env.PUNCHOUT_DOMAIN || 'NetworkID';
  const { origin, base } = where(target);
  const run = `smoke-${Date.now()}`;
  const post = async (path: string, xml: string) => {
    const res = await fetch(`${origin}${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: xml,
      signal: AbortSignal.timeout(30_000),
    });
    return status(await res.text());
  };
  console.log(`${origin}${base} · run ${run}`);

  // Refused before anything opens.
  const wrong = await post(
    'cxml/setup',
    doc(`${run}-0@smoke`, setup(header(identity, domain, `${secret}-wrong`), returnUrl, run)),
  );
  check(wrong.code === 401, 'a wrong shared secret is refused', `${wrong.code} ${wrong.text}`);

  // Setup: a StartPage on this deployment, whose link opens the buyer's cart once.
  const res = await fetch(`${origin}${base}cxml/setup`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: doc(`${run}-1@smoke`, setup(header(identity, domain, secret), returnUrl, run)),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.text();
  const started = status(answer);
  const start = /<StartPage>\s*<URL>([^<]+)<\/URL>/.exec(answer)?.[1];
  check(
    started.code === 200 && !!start,
    'setup answers a StartPage',
    `${started.code} ${started.text}`,
  );
  if (start) {
    const url = new URL(start.replaceAll('&amp;', '&'));
    const cartId = /\/cart\/start\/([^/]+)\//.exec(url.pathname)?.[1];
    check(url.origin === origin, 'the StartPage is on this deployment', url.origin);
    const open = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const cookie = open.headers.get('set-cookie')?.split(';')[0];
    check(
      open.status >= 300 && open.status < 400 && !!cookie,
      'the start link signs the buyer in to their cart',
      `${open.status}`,
    );
    if (cookie) {
      const cart = await fetch(new URL(`/cart/${cartId}`, origin), {
        headers: { cookie, accept: 'text/html' },
        signal: AbortSignal.timeout(30_000),
      });
      check(cart.status === 200, 'the buyer’s cart page opens', `${cart.status}`);
    }
    const again = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    check(again.status === 410, 'the start link works only once', `${again.status}`);
    console.log(`     cart ${cartId}`);
  }

  // A PO's life.
  const po = `PO-${run}`;
  const h = header(identity, domain, secret);
  const created = await post('cxml/order', doc(`${run}-n@smoke`, order(h, po, 'new', sku, 1)));
  check(
    created.code === 200 && !!created.body,
    'a new PO starts an order',
    `${created.code} ${created.text} ${created.body}`,
  );
  const resent = await post('cxml/order', doc(`${run}-n@smoke`, order(h, po, 'new', sku, 1)));
  check(resent.body === created.body, 'the same PO sent again answers the same order', resent.body);
  const updated = await post('cxml/order', doc(`${run}-u@smoke`, order(h, po, 'update', sku, 2)));
  check(
    updated.code === 200 && !!updated.body && updated.body !== created.body,
    'an update starts a replacement (and cancels the first)',
    `${updated.code} ${updated.text} ${updated.body}`,
  );
  const deleted = await post('cxml/order', doc(`${run}-d@smoke`, order(h, po, 'delete', sku, 2)));
  check(
    deleted.code === 200,
    'a delete cancels it',
    `${deleted.code} ${deleted.text} ${deleted.body}`,
  );
  const late = await post('cxml/order', doc(`${run}-u2@smoke`, order(h, po, 'update', sku, 3)));
  check(late.code === 409, 'an update after the delete is refused', `${late.code} ${late.text}`);

  console.log(
    failed
      ? `${failed} check(s) failed`
      : `All checks passed. Orders ${created.body} and ${updated.body} (${po}) were started and cancelled.`,
  );
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
