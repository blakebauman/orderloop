import type { Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import shopify from '../../../packages/core/tests/fixtures/shopify-order.json';

const env = {
  SHOPIFY_WEBHOOK_SECRET: 'shpss_test' as string | undefined,
  EDI_PARTNERS: JSON.stringify({ NORTHWIND: 'cus_northwind' }),
};
const startOrderOnce = vi.fn();

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ startOrderOnce }) }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({
  currencies: async () => [{ currency: 'USD' }],
  listOrders: async () => [],
  customerIdByEmail: async (email: string) => (email === 'jon@example.com' ? 'cus_jon' : undefined),
}));
vi.mock('~/lib/audit.server', () => ({ listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({ actor: () => 'api', forbidden: () => 'Forbidden' }));
vi.mock('~/lib/webhooks.server', () => ({}));

const { handleApi, handleShopifyOrder } = await import('~/lib/api.server');

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...mac));
}

async function fromShopify(body: unknown, opts: { topic?: string; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  return handleShopifyOrder(
    new Request('https://app.test/api/v1/channels/shopify/orders', {
      method: 'POST',
      headers: {
        'x-shopify-hmac-sha256': await hmac(opts.secret ?? 'shpss_test', raw),
        'x-shopify-topic': opts.topic ?? 'orders/create',
      },
      body: raw,
    }),
  );
}

describe('Shopify orders', () => {
  beforeEach(() => {
    startOrderOnce.mockReset();
    env.SHOPIFY_WEBHOOK_SECRET = 'shpss_test';
  });

  it('starts the mapped order for the matching customer, once', async () => {
    startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1' });
    const res = await fromShopify(shopify);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orderId: 'ord_1', flowId: 'tpl-storefront-order' });
    expect(startOrderOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'tpl-storefront-order',
        idempotencyKey: 'order:web:820982911946154500',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        input: expect.objectContaining({
          model: 'b2c',
          channel: 'web',
          customerId: 'cus_jon',
          lines: [
            expect.objectContaining({ sku: 'MON-27', qty: 1, unitPrice: 349 }),
            expect.objectContaining({ sku: 'TEE-01', qty: 2, unitPrice: 32 }),
          ],
          meta: expect.objectContaining({ via: 'webhook', source: 'shopify' }),
        }),
      }),
    );
    startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1', replayed: true });
    expect((await fromShopify(shopify)).status).toBe(200);
  });

  it('refuses a bad signature, ignores other topics and reports unmappable orders', async () => {
    expect((await fromShopify(shopify, { secret: 'wrong' })).status).toBe(401);
    const ignored = await fromShopify(shopify, { topic: 'orders/updated' });
    expect(await ignored.json()).toEqual({ ignored: true, topic: 'orders/updated' });
    const noSku = await fromShopify({
      ...shopify,
      line_items: [{ sku: null, title: 'Gift wrap', quantity: 1, price: '5.00' }],
    });
    expect(noSku.status).toBe(400);
    env.SHOPIFY_WEBHOOK_SECRET = undefined;
    expect((await fromShopify(shopify)).status).toBe(503);
    expect(startOrderOnce).not.toHaveBeenCalled();
  });
});

const operator: Principal = { kind: 'token', id: 'tok_1', name: 'edi', role: 'operator' };
const isa = (sender: string) =>
  `ISA*00*          *00*          *ZZ*${sender.padEnd(15)}*ZZ*ORDERLOOP      *261014*1200*U*00401*000000001*0*P*>~`;
const tx = (control: string, po: string) =>
  [
    `ST*850*${control}`,
    `BEG*00*SA*${po}**20261014`,
    'PO1*1*120*EA*21.50**VP*WID-100',
    'CTT*1',
    `SE*5*${control}`,
  ].join('~');
const x12 = (sender: string, txs: string[]) =>
  `${isa(sender)}GS*PO*${sender}*ORDERLOOP*20261014*1200*1*X*004010~${txs.join('~')}~GE*${txs.length}*1~IEA*1*000000001~`;
const postEdi = (body: string, role: Principal['role'] = 'operator') =>
  handleApi(
    new Request('https://app.test/api/v1/channels/edi/850', {
      method: 'POST',
      headers: { 'content-type': 'application/edi-x12' },
      body,
    }),
    { ...operator, role },
  );

describe('EDI 850', () => {
  beforeEach(() => startOrderOnce.mockReset());

  it('starts one order per purchase order for the partner’s customer', async () => {
    startOrderOnce
      .mockResolvedValueOnce({ orderId: 'ord_a' })
      .mockResolvedValueOnce({ orderId: 'ord_b', replayed: true });
    const res = await postEdi(x12('NORTHWIND', [tx('0001', 'NW-1'), tx('0002', 'NW-2')]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sender: 'NORTHWIND',
      results: [
        {
          control: '0001',
          poNumber: 'NW-1',
          status: 201,
          orderId: 'ord_a',
          flowId: 'tpl-b2b-order',
        },
        { control: '0002', poNumber: 'NW-2', status: 200, orderId: 'ord_b', replayed: true },
      ],
    });
    expect(startOrderOnce.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: 'order:edi:NORTHWIND:NW-1',
      input: { model: 'b2b', channel: 'edi', customerId: 'cus_northwind' },
    });
  });

  it('refuses unknown partners, bad X12 and callers below operator', async () => {
    expect((await postEdi(x12('STRANGER', [tx('0001', 'X-1')]))).status).toBe(403);
    expect((await postEdi('not x12')).status).toBe(400);
    expect((await postEdi(x12('NORTHWIND', [tx('0001', 'NW-1')]), 'viewer')).status).toBe(403);
    expect(startOrderOnce).not.toHaveBeenCalled();
  });
});
