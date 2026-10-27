/**
 * The plugin's admin page (`pageRole: admin`): the partners that may punch out, how to set one up
 * in their procurement system, and their secrets, each shown once when made or rotated. Each page is
 * a view the app draws in its own shell: forms post back here and each answer is the next view.
 */

import { type PluginView, viewResponse } from '@orderloop/plugin-sdk';
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
    return 'An idle timeout is 5 minutes to 24 hours.';
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

/** What the page says above the partners: a secret to copy (shown once), or why a form failed. */
type Notice = { secret?: { label: string; value: string }; error?: string };

/** The page, as a view the app draws in its own shell (`viewResponse`). */
function list(partners: Partner[], origin: string, notice: Notice = {}): Response {
  const status = (p: Partner) => (p.status === 'active' ? 'Active' : 'Disabled');
  const view: PluginView = {
    title: 'Punchout',
    description:
      'Procurement systems (Ariba, Coupa, SAP and others) that may open a cart here for their buyers and send the purchase orders.',
    blocks: [
      ...(notice.error
        ? [{ type: 'alert' as const, tone: 'error' as const, text: notice.error }]
        : []),
      ...(notice.secret
        ? [
            {
              type: 'alert' as const,
              tone: 'warning' as const,
              title: 'Copy it now',
              text: 'This secret isn’t shown again. Give it to the customer’s procurement admin as their SharedSecret (cXML) or PASSWORD (OCI).',
            },
            { type: 'code' as const, label: notice.secret.label, text: notice.secret.value },
          ]
        : []),
      {
        type: 'section',
        title: 'Partners',
        blocks: [
          {
            type: 'table',
            columns: [
              { key: 'partner', label: 'Partner' },
              { key: 'protocol', label: 'Protocol' },
              { key: 'flow', label: 'Flow' },
              { key: 'returns', label: 'Returns to' },
              { key: 'status', label: 'Status' },
            ],
            rows: partners.map((p) => ({
              cells: {
                partner: {
                  text: `${p.name} · ${p.protocol === 'cxml' ? `${p.fromDomain} / ${p.identity}` : `USERNAME ${p.identity}`}`,
                },
                protocol: p.protocol.toUpperCase(),
                flow: {
                  text: p.customerId ? `${p.flowId} · ${p.customerId}` : p.flowId,
                  mono: true,
                },
                returns: p.returnHosts.join(', '),
                status: { text: status(p), tone: p.status === 'active' ? 'ok' : 'muted' },
              },
              actions: [
                {
                  type: 'form' as const,
                  action: `partners/${p.id}/rotate`,
                  fields: [],
                  submit: 'Rotate secret',
                  confirm: `Rotate ${p.name}'s secret? The old one stops working at once.`,
                },
                {
                  type: 'form' as const,
                  action: `partners/${p.id}/${p.status === 'active' ? 'disable' : 'enable'}`,
                  fields: [],
                  submit: p.status === 'active' ? 'Disable' : 'Enable',
                },
              ],
            })),
            empty: 'No partners yet.',
          },
        ],
      },
      {
        type: 'section',
        title: 'Setting up a buyer’s system',
        blocks: [
          {
            type: 'list',
            items: [
              `cXML setup URL: ${origin}cxml/setup (PunchOutSetupRequest)`,
              `cXML order URL: ${origin}cxml/order (OrderRequest: new, update and delete)`,
              `OCI URL: ${origin}oci/setup with USERNAME, PASSWORD (the secret) and HOOK_URL, by GET or POST`,
              'A cXML buyer is found by its From credential and proves itself with the Sender’s SharedSecret.',
            ],
          },
        ],
      },
      {
        type: 'section',
        title: 'Add a partner',
        blocks: [
          {
            type: 'form',
            action: 'partners',
            submit: 'Add partner',
            fields: [
              { name: 'name', label: 'Name', required: true },
              {
                name: 'protocol',
                label: 'Protocol',
                kind: 'select',
                options: PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() })),
              },
              { name: 'fromDomain', label: 'From domain (cXML)', placeholder: 'NetworkID' },
              {
                name: 'identity',
                label: 'Identity (cXML From identity, or OCI USERNAME)',
                required: true,
              },
              {
                name: 'supplierDomain',
                label: 'Our credential domain in returned carts',
                placeholder: 'NetworkID',
              },
              {
                name: 'supplierIdentity',
                label: 'Our credential identity in returned carts',
                placeholder: 'orderloop',
              },
              { name: 'customerId', label: 'Customer id', placeholder: 'cus_…' },
              {
                name: 'flowId',
                label: 'Flow id (prices its carts, runs its orders)',
                required: true,
                placeholder: 'tpl-b2b-order',
              },
              { name: 'model', label: 'Commerce model of the flow', value: 'b2b' },
              {
                name: 'returnHosts',
                label: 'Return hosts (comma separated)',
                required: true,
                placeholder: 'service.ariba.com',
              },
              {
                name: 'frameOrigins',
                label: 'Origins that may frame the catalog (optional)',
                placeholder: 'https://service.ariba.com',
              },
              {
                name: 'sessionMinutes',
                label: 'Idle timeout in minutes (a cart closes this long after its buyer stops)',
                kind: 'number',
                value: 120,
              },
            ],
          },
        ],
      },
    ],
  };
  return viewResponse(view, notice.error ? { status: 400 } : {});
}
export async function adminPages(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // The app's address isn't forwarded to plugins; the page names the paths on it, under the
  // deployment's alias for the plugin when it has one (`/punchout/`), else its own.
  const alias = request.headers.get('x-orderloop-alias');
  const mount = alias && /^\/[a-z][a-z0-9-]{1,30}\/$/.test(alias) ? alias : BASE;
  const origin = `https://<your OrderLoop address>${mount}`;
  const path = url.pathname;
  if (request.method === 'GET' && path === BASE) return list(await listPartners(env), origin);
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (path === `${BASE}partners`) {
    const input = partnerFrom(await request.formData());
    if (typeof input === 'string') return list(await listPartners(env), origin, { error: input });
    try {
      const { secret } = await addPartner(env, input);
      return list(await listPartners(env), origin, {
        secret: { label: `${input.name}'s secret`, value: secret },
      });
    } catch {
      return list(await listPartners(env), origin, {
        error: 'A partner with that protocol, domain and identity already exists.',
      });
    }
  }
  const m = /^\/plugins\/punchout\/partners\/(ptn_[a-z0-9]+)\/(rotate|disable|enable)$/.exec(path);
  if (!m) return new Response('Not found', { status: 404 });
  const [, id, action] = m;
  if (action === 'rotate') {
    const secret = await rotateSecret(env, id!);
    return list(
      await listPartners(env),
      origin,
      secret ? { secret: { label: 'New secret', value: secret } } : {},
    );
  }
  await setStatus(env, id!, action === 'disable' ? 'disabled' : 'active');
  return list(await listPartners(env), origin);
}
