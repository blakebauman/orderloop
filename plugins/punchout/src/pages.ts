/**
 * The plugin's admin page (`pageRole: admin`): the partners that may punch out, how to set one up
 * in their procurement system, and their secrets, each shown once when made or rotated. Pages run no
 * script: forms post back here and each answer is a whole page.
 */

import {
  addPartner,
  listPartners,
  type Partner,
  type PartnerInput,
  PROTOCOLS,
  type Protocol,
  rotateSecret,
  setStatus,
} from './partners';

const BASE = '/plugins/punchout/';
const h = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}
label{display:grid;gap:.2rem;margin:.4rem 0}input,select{padding:.3rem;font:inherit}
.secret{font-family:monospace;padding:.6rem;border:1px solid #c80;background:#fff8e6}
form.inline{display:inline}code{font-size:13px}`;

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Punchout</title><style>${STYLE}</style></head><body><h1>Punchout</h1>${body}</body></html>`,
    {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}

const hosts = (raw: string) =>
  raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** A partner from the form, or why it can't be one. */
function partnerFrom(f: FormData): PartnerInput | string {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const protocol = s('protocol') as Protocol;
  if (!PROTOCOLS.includes(protocol)) return 'Pick cXML or OCI.';
  const returnHosts = hosts(s('returnHosts'));
  if (!returnHosts.length || returnHosts.some((x) => !/^[a-z0-9.-]+$/.test(x)))
    return 'List the host names the cart may go back to (BrowserFormPost / HOOK_URL), e.g. service.ariba.com.';
  const frameOrigins = hosts(s('frameOrigins'));
  if (frameOrigins.some((o) => !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o)))
    return 'Frame origins are https origins, e.g. https://service.ariba.com.';
  const minutes = Number(s('sessionMinutes') || 120);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60)
    return 'A session lasts 5 minutes to 24 hours.';
  if (!s('name') || !s('identity') || !s('flowId')) return 'Name, identity and flow are required.';
  if (protocol === 'cxml' && !s('fromDomain')) return 'A cXML partner needs its From domain.';
  return {
    name: s('name').slice(0, 120),
    protocol,
    fromDomain: protocol === 'cxml' ? s('fromDomain') : '',
    identity: s('identity'),
    supplierDomain: s('supplierDomain') || 'NetworkID',
    supplierIdentity: s('supplierIdentity') || 'orderloop',
    customerId: s('customerId') || null,
    flowId: s('flowId'),
    model: s('model') || 'b2b',
    returnHosts,
    frameOrigins,
    sessionMinutes: minutes,
  };
}

const secretBox = (what: string, secret: string) =>
  `<p class="secret">${h(what)}: <strong>${h(secret)}</strong><br>Copy it now; it isn't shown again.</p>`;

function list(partners: Partner[], origin: string, notice = ''): Response {
  const rows = partners
    .map(
      (
        p,
      ) => `<tr><td><strong>${h(p.name)}</strong><br><small>${p.protocol === 'cxml' ? `From ${h(p.fromDomain)} / ${h(p.identity)}` : `USERNAME ${h(p.identity)}`}</small></td>
<td>${p.protocol.toUpperCase()}</td><td><code>${h(p.flowId)}</code>${p.customerId ? `<br><small>${h(p.customerId)}</small>` : ''}</td>
<td>${p.returnHosts.map(h).join('<br>')}</td><td>${p.status}</td>
<td><form class="inline" method="post" action="${BASE}partners/${h(p.id)}/rotate"><button>Rotate secret</button></form>
<form class="inline" method="post" action="${BASE}partners/${h(p.id)}/${p.status === 'active' ? 'disable' : 'enable'}"><button>${p.status === 'active' ? 'Disable' : 'Enable'}</button></form></td></tr>`,
    )
    .join('');
  return page(`${notice}
<h2>Partners</h2>
${partners.length ? `<table><tr><th>Partner</th><th>Protocol</th><th>Flow</th><th>Returns to</th><th>Status</th><th></th></tr>${rows}</table>` : '<p>No partners yet.</p>'}
<h2>Setting up a buyer's system</h2>
<ul><li>cXML setup URL: <code>${h(origin)}${BASE}cxml/setup</code> (PunchOutSetupRequest), and order URL <code>${h(origin)}${BASE}cxml/order</code> (OrderRequest). The buyer's From credential and the Sender SharedSecret identify them.</li>
<li>OCI URL: <code>${h(origin)}${BASE}oci/setup</code> with <code>USERNAME</code>, <code>PASSWORD</code> (the secret) and <code>HOOK_URL</code>, opened with GET.</li></ul>
<h2>Add a partner</h2>
<form method="post" action="${BASE}partners">
<label>Name <input name="name" required maxlength="120"></label>
<label>Protocol <select name="protocol">${PROTOCOLS.map((p) => `<option value="${p}">${p.toUpperCase()}</option>`).join('')}</select></label>
<label>From domain (cXML, e.g. NetworkID) <input name="fromDomain"></label>
<label>Identity (cXML From identity, or OCI USERNAME) <input name="identity" required></label>
<label>Our credential domain and identity in returned carts <input name="supplierDomain" placeholder="NetworkID"> <input name="supplierIdentity" placeholder="orderloop"></label>
<label>Customer id <input name="customerId" placeholder="cus_…"></label>
<label>Flow id (priced, and run for its orders) <input name="flowId" required placeholder="tpl-b2b-order"></label>
<label>Commerce model of the flow <input name="model" value="b2b"></label>
<label>Return hosts (comma separated) <input name="returnHosts" required placeholder="service.ariba.com"></label>
<label>Origins that may frame the catalog (optional) <input name="frameOrigins" placeholder="https://service.ariba.com"></label>
<label>Session minutes <input name="sessionMinutes" type="number" value="120" min="5" max="1440"></label>
<button>Add partner</button></form>`);
}

export async function adminPages(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // The app's address isn't forwarded to plugins; the page names the paths on it.
  const origin = 'https://<your OrderLoop address>';
  const path = url.pathname;
  if (request.method === 'GET' && path === BASE) return list(await listPartners(env), origin);
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (path === `${BASE}partners`) {
    const input = partnerFrom(await request.formData());
    if (typeof input === 'string')
      return list(await listPartners(env), origin, `<p role="alert">${h(input)}</p>`);
    try {
      const { secret } = await addPartner(env, input);
      return list(await listPartners(env), origin, secretBox(`${input.name}'s secret`, secret));
    } catch {
      return list(
        await listPartners(env),
        origin,
        '<p role="alert">A partner with that protocol, domain and identity already exists.</p>',
      );
    }
  }
  const m = /^\/plugins\/punchout\/partners\/(ptn_[a-z0-9]+)\/(rotate|disable|enable)$/.exec(path);
  if (!m) return new Response('Not found', { status: 404 });
  const [, id, action] = m;
  if (action === 'rotate') {
    const secret = await rotateSecret(env, id!);
    return list(await listPartners(env), origin, secret ? secretBox('New secret', secret) : '');
  }
  await setStatus(env, id!, action === 'disable' ? 'disabled' : 'active');
  return list(await listPartners(env), origin);
}
