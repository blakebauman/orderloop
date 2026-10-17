import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import {
  businessProfile,
  CHECKOUT_CAPABILITY,
  CHECKOUT_TTL_MS,
  type CheckoutSession,
  checkoutPatch,
  contentDigest,
  digestMatches,
  FULFILLMENT_CAPABILITY,
  importSigningKey,
  importVerifyKey,
  negotiate,
  ORDER_CAPABILITY,
  type Order,
  orderPermalink,
  parseDictionary,
  parsePlatformProfile,
  protocolIssues,
  publicJwk,
  readUcpSettings,
  selectedInstrument,
  serializeDictionary,
  signMessage,
  toUcpCheckout,
  toUcpOrder,
  UCP_OFF,
  UCP_VERSION,
  type UcpCapability,
  type UcpPaymentHandler,
  ucpAgentProfile,
  ucpCheckoutInput,
  ucpCompleteInput,
  ucpErrorResponse,
  verifyMessage,
} from '../src';

// ── The published schemas (tests/fixtures/ucp), for checking what we serve ──

const ROOT = join(__dirname, 'fixtures/ucp/schemas');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.json') ? [p] : [];
  });
const schemas = files(ROOT).map((p) => JSON.parse(readFileSync(p, 'utf8')) as { $id: string });

function conformsTo(ref: string, value: unknown) {
  const v = new Validator({ $ref: `https://ucp.dev/schemas/${ref}` }, '2020-12', false);
  for (const s of schemas) v.addSchema(s as never, s.$id);
  const r = v.validate(value);
  return r.valid ? [] : r.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
}

const ORIGIN = 'https://shop.example';

const handler: UcpPaymentHandler = {
  name: 'app.orderloop.stripe',
  id: 'stripe',
  version: UCP_VERSION,
  spec: 'https://docs.orderloop.app/reference/ucp/',
  schema: 'https://orderloop.app/ucp/handlers/stripe.json',
  available_instruments: [{ type: 'card' }],
  config: { publishable_key: 'pk_test_123' },
};

const all = new Map<UcpCapability, string>([
  [CHECKOUT_CAPABILITY, UCP_VERSION],
  [FULFILLMENT_CAPABILITY, UCP_VERSION],
  [ORDER_CAPABILITY, UCP_VERSION],
]);

const platformDoc = (caps: Record<string, unknown>, version = UCP_VERSION) => ({
  ucp: {
    version,
    services: {},
    payment_handlers: {},
    capabilities: caps,
  },
});

describe('schema fixtures', () => {
  it('reject what the schemas do not allow', () => {
    expect(conformsTo('shopping/order.json', {}).length).toBeGreaterThan(0);
    expect(
      conformsTo('shopping/checkout.json', {
        ...toUcpCheckout(session(), view),
        status: 'paid',
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('structured fields', () => {
  it('reads UCP-Agent and refuses what is not a dictionary of strings', () => {
    expect(ucpAgentProfile('profile="https://agent.example/p.json"')).toBe(
      'https://agent.example/p.json',
    );
    expect(ucpAgentProfile('profile="http://agent.example/p.json"')).toBeNull();
    expect(ucpAgentProfile('profile=https://agent.example')).toBeNull();
    expect(ucpAgentProfile('profile="https://a.example", ')).toBeNull();
    expect(ucpAgentProfile(null)).toBeNull();
  });

  it('round-trips inner lists with parameters', () => {
    const header =
      'sig1=("@method" "@authority" "content-digest");created=1700000000;keyid="k-1", sig2=:AQID:';
    const dict = parseDictionary(header)!;
    expect(serializeDictionary(dict)).toBe(header);
  });
});

describe('message signatures', () => {
  it('signs a webhook that verifies with the published key, and fails once altered', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] };
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'k-1' };
    const published = publicJwk(jwk as never);
    expect(published).toMatchObject({ kid: 'k-1', kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(published).not.toHaveProperty('d');

    const body = JSON.stringify({ id: 'ord_1' });
    const headers = new Headers({
      'content-type': 'application/json',
      'content-digest': await contentDigest(body),
      'ucp-agent': `profile="${ORIGIN}/.well-known/ucp"`,
    });
    const msg = { method: 'POST', url: 'https://agent.example/hooks/orders', headers };
    const components = [
      '@method',
      '@authority',
      '@path',
      'content-digest',
      'content-type',
      'ucp-agent',
    ];
    const sig = await signMessage(msg, components, await importSigningKey(jwk as never), 'k-1');
    headers.set('signature-input', sig.signatureInput);
    headers.set('signature', sig.signature);

    const key = await importVerifyKey(published);
    const keyFor = async (id: string) => (id === 'k-1' ? key : null);
    expect(await verifyMessage(msg, keyFor, ['content-digest'])).toMatchObject({ ok: true });
    expect(await digestMatches(headers.get('content-digest'), body)).toBe(true);
    expect(await digestMatches(headers.get('content-digest'), `${body} `)).toBe(false);

    const moved = { ...msg, url: 'https://agent.example/hooks/other' };
    expect(await verifyMessage(moved, keyFor)).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    expect(await verifyMessage(msg, async () => null)).toMatchObject({ ok: false });
    expect(await verifyMessage(msg, keyFor, ['idempotency-key'])).toMatchObject({ ok: false });
  });
});

describe('profiles and negotiation', () => {
  it('publishes a business profile the schema accepts', () => {
    const profile = businessProfile(
      ORIGIN,
      [handler],
      [{ kid: 'k-1', kty: 'EC', crv: 'P-256', x: 'x', y: 'y', alg: 'ES256', use: 'sig' }],
    );
    expect(conformsTo('profile.json#/$defs/business_schema', profile)).toEqual([]);
    expect(profile.ucp.services['dev.ucp.shopping'].map((s) => s.endpoint)).toEqual([
      `${ORIGIN}/ucp/v1`,
      `${ORIGIN}/ucp/mcp`,
    ]);
  });

  it('activates what both sides list and prunes an orphaned extension', () => {
    const entry = { version: UCP_VERSION, spec: 'https://ucp.dev/x', schema: 'https://ucp.dev/y' };
    const p = parsePlatformProfile(
      platformDoc({
        [FULFILLMENT_CAPABILITY]: [{ ...entry, extends: CHECKOUT_CAPABILITY }],
        [ORDER_CAPABILITY]: [{ ...entry, config: { webhook_url: 'https://agent.example/hooks' } }],
      }),
    );
    if ('problem' in p) throw new Error(p.problem);
    expect(p.webhookUrl).toBe('https://agent.example/hooks');
    const n = negotiate(p);
    expect(n.ok && [...n.capabilities.keys()]).toEqual([ORDER_CAPABILITY]);
  });

  it('refuses a newer protocol and an empty intersection', () => {
    const newer = parsePlatformProfile(platformDoc({}, '2099-01-01'));
    if ('problem' in newer) throw new Error(newer.problem);
    expect(negotiate(newer)).toMatchObject({ ok: false, code: 'version_unsupported' });
    const old = parsePlatformProfile(
      platformDoc({ [CHECKOUT_CAPABILITY]: [{ version: '2026-01-11' }] }),
    );
    if ('problem' in old) throw new Error(old.problem);
    expect(negotiate(old)).toMatchObject({ ok: false, code: 'capabilities_incompatible' });
  });

  it('explains a profile it cannot use', () => {
    expect(parsePlatformProfile('nope')).toHaveProperty('problem');
    expect(parsePlatformProfile({ ucp: { version: 'today' } })).toHaveProperty('problem');
  });
});

describe('settings', () => {
  it('reads stored settings and falls back to off', () => {
    expect(readUcpSettings(undefined)).toEqual(UCP_OFF);
    expect(readUcpSettings('{not json')).toEqual(UCP_OFF);
    const s = readUcpSettings(
      JSON.stringify({
        checkoutFlowId: 'tpl-storefront-order',
        orderUrl: 'https://shop.example/o/{id}',
      }),
    );
    expect(s.links).toEqual([]);
    expect(orderPermalink(s, ORIGIN, 'ord_1')).toBe('https://shop.example/o/ord_1');
    expect(orderPermalink(UCP_OFF, ORIGIN, 'ord_1')).toBe(`${ORIGIN}/orders/ord_1`);
  });
});

const session = (s: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'chk_1',
  ownerId: 'ucp_1',
  status: 'ready_for_complete',
  currency: 'USD',
  lines: [
    { id: 'li_1', sku: 'TEE-M', qty: 2 },
    { id: 'li_2', sku: 'EBOOK', qty: 1 },
  ],
  buyer: { email: 'ada@example.com', firstName: 'Ada' },
  fulfillment: 'ship',
  shipTo: {
    name: 'Ada Lovelace',
    line1: '1 Main St',
    city: 'Austin',
    postalCode: '78701',
    country: 'US',
  },
  shippingOption: 'standard',
  quote: {
    currency: 'USD',
    lines: [
      { id: 'li_1', sku: 'TEE-M', title: 'Tee', qty: 2, unitPrice: 19.99, ships: true },
      { id: 'li_2', sku: 'EBOOK', title: 'Ebook', qty: 1, unitPrice: 9.5, ships: false },
    ],
    subtotal: 49.48,
    shipping: 6,
    tax: 4.44,
    total: 59.92,
    shippingOptions: [
      { id: 'standard', title: 'Standard', carrier: 'ups', amount: 6, minDays: 3, maxDays: 5 },
      { id: 'express', title: 'Express', carrier: 'fedex', amount: 15, minDays: 1, maxDays: 2 },
    ],
    shippingOption: 'standard',
    ships: true,
  },
  issues: [],
  orderId: null,
  createdAt: 0,
  updatedAt: 0,
  expiresAt: CHECKOUT_TTL_MS,
  version: 3,
  ...s,
});

const view = {
  capabilities: all,
  handlers: [handler],
  settings: {
    ...UCP_OFF,
    links: [{ type: 'privacy_policy', url: 'https://shop.example/privacy' }],
  },
};

describe('checkout', () => {
  it('reads a create request, ship-to and option included', () => {
    const req = ucpCheckoutInput.parse({
      line_items: [{ item: { id: 'TEE-M' }, quantity: 2 }],
      buyer: { email: 'ada@example.com', first_name: 'Ada' },
      fulfillment: {
        methods: [
          {
            type: 'shipping',
            destinations: [
              {
                street_address: '1 Main St',
                address_locality: 'Austin',
                postal_code: '78701',
                address_country: 'US',
                first_name: 'Ada',
                last_name: 'Lovelace',
              },
            ],
            groups: [{ selected_option_id: 'express' }],
          },
        ],
      },
    });
    expect(checkoutPatch(req)).toEqual({
      lines: [{ id: undefined, sku: 'TEE-M', qty: 2 }],
      buyer: { email: 'ada@example.com', firstName: 'Ada' },
      shipTo: {
        name: 'Ada Lovelace',
        line1: '1 Main St',
        city: 'Austin',
        postalCode: '78701',
        country: 'US',
      },
      shippingOption: 'express',
    });
  });

  it('keeps the held ship-to when an update names it by id, and clears what an update leaves out', () => {
    const current = session();
    const keep = checkoutPatch(
      ucpCheckoutInput.parse({
        line_items: [{ id: 'li_1', item: { id: 'TEE-M' }, quantity: 1 }],
        fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
      }),
      current,
    );
    expect(keep.shipTo).toEqual(current.shipTo);
    expect(keep.buyer).toEqual({});
    expect(keep.shippingOption).toBeNull();
    const none = checkoutPatch(
      ucpCheckoutInput.parse({ line_items: [{ item: { id: 'TEE-M' }, quantity: 1 }] }),
      current,
    );
    expect(none.shipTo).toBeNull();
  });

  it('refuses requests the schema would not allow', () => {
    expect(ucpCheckoutInput.safeParse({ line_items: [] }).success).toBe(false);
    expect(
      ucpCheckoutInput.safeParse({ line_items: [{ item: { id: 'A' }, quantity: 0 }] }).success,
    ).toBe(false);
  });

  it('serves a checkout the schema (with fulfillment) accepts, in minor units', () => {
    const c = toUcpCheckout(session(), view);
    expect(conformsTo('shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout', c)).toEqual([]);
    expect(c.line_items[0]).toMatchObject({ item: { id: 'TEE-M', price: 1999 }, quantity: 2 });
    expect(c.totals).toEqual([
      { type: 'subtotal', display_text: 'Subtotal', amount: 4948 },
      { type: 'fulfillment', display_text: 'Shipping', amount: 600 },
      { type: 'tax', display_text: 'Tax', amount: 444 },
      { type: 'total', display_text: 'Total', amount: 5992 },
    ]);
    const method = c.fulfillment!.methods[0]!;
    expect(method.line_item_ids).toEqual(['li_1']);
    expect(method.groups[0]!.selected_option_id).toBe('standard');
    expect(method.destinations[0]).toMatchObject({ id: 'dest_1', street_address: '1 Main St' });
    expect(c.ucp.capabilities).toEqual({
      [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }],
      [FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION }],
    });
    expect(c.ucp.payment_handlers).toEqual({
      'app.orderloop.stripe': [
        {
          id: 'stripe',
          version: UCP_VERSION,
          spec: handler.spec,
          schema: handler.schema,
          available_instruments: [{ type: 'card' }],
          config: { publishable_key: 'pk_test_123' },
        },
      ],
    });
  });

  it('serves an incomplete and a completed checkout the schema accepts', () => {
    const incomplete = toUcpCheckout(
      session({
        status: 'incomplete',
        quote: null,
        issues: [
          {
            kind: 'error',
            code: 'item_unavailable',
            content: 'No such item',
            path: '$.line_items[0]',
            severity: 'recoverable',
          },
        ],
      }),
      view,
    );
    expect(conformsTo('shopping/checkout.json', incomplete)).toEqual([]);
    expect(incomplete.messages).toEqual([
      {
        type: 'error',
        code: 'item_unavailable',
        content: 'No such item',
        path: '$.line_items[0]',
        severity: 'recoverable',
      },
    ]);
    const done = toUcpCheckout(session({ status: 'completed', orderId: 'ord_1' }), {
      ...view,
      permalink: 'https://shop.example/orders/ord_1',
    });
    expect(conformsTo('shopping/checkout.json', done)).toEqual([]);
    expect(done.order).toEqual({ id: 'ord_1', permalink_url: 'https://shop.example/orders/ord_1' });
    expect(done).not.toHaveProperty('expires_at');
  });

  it('leaves fulfillment out when the platform did not negotiate it, and says why it cannot ship', () => {
    const caps = new Map<UcpCapability, string>([[CHECKOUT_CAPABILITY, UCP_VERSION]]);
    expect(toUcpCheckout(session(), { ...view, capabilities: caps })).not.toHaveProperty(
      'fulfillment',
    );
    expect(protocolIssues(session(), caps)[0]).toMatchObject({ code: 'fulfillment_required' });
    expect(protocolIssues(session(), all)).toEqual([]);
  });

  it('picks the selected instrument at completion', () => {
    const one = ucpCompleteInput.parse({
      payment: { instruments: [{ id: 'i1', handler_id: 'stripe', type: 'card' }] },
    });
    expect(selectedInstrument(one)?.id).toBe('i1');
    const two = ucpCompleteInput.parse({
      payment: {
        instruments: [
          { id: 'i1', handler_id: 'stripe', type: 'card' },
          { id: 'i2', handler_id: 'stripe', type: 'card', selected: true },
        ],
      },
    });
    expect(selectedInstrument(two)?.id).toBe('i2');
  });

  it('serves an error response the schema accepts', () => {
    const r = ucpErrorResponse([
      { kind: 'error', code: 'not_found', content: 'No such checkout', severity: 'unrecoverable' },
    ]);
    expect(conformsTo('common/types/error_response.json', r)).toEqual([]);
  });
});

describe('order', () => {
  const order: Order = {
    id: 'ord_1',
    model: 'b2c',
    channel: 'agent',
    currency: 'USD',
    lines: [
      { sku: 'TEE-M', name: 'Tee', qty: 2, unitPrice: 19.99 },
      { sku: 'EBOOK', name: 'Ebook', qty: 1, unitPrice: 9.5 },
    ],
    meta: {},
    createdAt: 0,
    subtotal: 49.48,
    shipping: 6,
    tax: 4.44,
    total: 59.92,
  };
  const facts = {
    order,
    status: 'running' as const,
    checkoutId: 'chk_1',
    checkoutLines: session().lines,
    physical: new Set(['TEE-M']),
    shipTo: session().shipTo,
    shipments: [],
    refunds: [],
    updatedAt: 1_000,
    permalink: 'https://shop.example/orders/ord_1',
  };

  it('serves a placed order the schema accepts', () => {
    const o = toUcpOrder(facts, all);
    expect(conformsTo('shopping/order.json', o)).toEqual([]);
    expect(o.line_items.map((l) => [l.id, l.status])).toEqual([
      ['li_1', 'processing'],
      ['li_2', 'processing'],
    ]);
    expect(o.ucp.capabilities).toEqual({ [ORDER_CAPABILITY]: [{ version: UCP_VERSION }] });
  });

  it('turns shipments into events and refunds into negative adjustments', () => {
    const o = toUcpOrder(
      {
        ...facts,
        status: 'completed',
        shipments: [
          {
            id: 'shp_1',
            carrier: 'ups',
            tracking: 'UPS123',
            status: 'label_created',
            createdAt: 500,
          },
          { id: 'shp_x', carrier: 'ups', tracking: 'UPS999', status: 'cancelled', createdAt: 600 },
        ],
        refunds: [{ id: 'ref_1', amount: 19.99, status: 'succeeded', createdAt: 900 }],
      },
      all,
    );
    expect(conformsTo('shopping/order.json', o)).toEqual([]);
    expect(o.fulfillment.events).toEqual([
      {
        id: 'shp_1',
        occurred_at: new Date(500).toISOString(),
        type: 'shipped',
        line_items: [{ id: 'li_1', quantity: 2 }],
        tracking_number: 'UPS123',
        carrier: 'ups',
      },
    ]);
    expect(o.line_items.map((l) => l.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(o.adjustments).toEqual([
      expect.objectContaining({
        type: 'refund',
        status: 'completed',
        totals: [{ type: 'total', amount: -1999 }],
      }),
    ]);
  });

  it('removes every line of an order that ended unfulfilled', () => {
    const o = toUcpOrder({ ...facts, status: 'cancelled' }, all);
    expect(conformsTo('shopping/order.json', o)).toEqual([]);
    expect(o.line_items.every((l) => l.status === 'removed' && l.quantity.total === 0)).toBe(true);
    expect(o.adjustments?.[0]).toMatchObject({
      type: 'cancellation',
      line_items: [
        { id: 'li_1', quantity: -2 },
        { id: 'li_2', quantity: -1 },
      ],
    });
  });
});
