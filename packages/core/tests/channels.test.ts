import { describe, expect, it } from 'vitest';
import {
  inboundOrderSchema,
  parseX12,
  type ShopifyOrder,
  shopifyToInbound,
  verifyShopifyHmac,
  x12850ToInbound,
} from '../src';
import shopify from './fixtures/shopify-order.json';

const order = shopify as unknown as ShopifyOrder;

describe('Shopify orders', () => {
  it('maps an orders/create payload onto a valid inbound order', () => {
    const r = shopifyToInbound(order, { customerId: 'cus_ada' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(inboundOrderSchema.parse(r.order)).toMatchObject({
      model: 'b2c',
      channel: 'web',
      externalId: '820982911946154500',
      source: 'shopify',
      title: 'Shopify order #1001',
      customerId: 'cus_ada',
      currency: 'USD',
      contact: { email: 'jon@example.com', name: 'Jon Snow' },
      lines: [
        { sku: 'MON-27', name: '27" monitor', qty: 1, unitPrice: 349 },
        { sku: 'TEE-01', name: 'Organic cotton tee', qty: 2, unitPrice: 32 },
      ],
      shipTo: {
        line1: '1 Market St',
        city: 'San Francisco',
        region: 'CA',
        postalCode: '94105',
        country: 'US',
        latitude: 37.7946,
      },
    });
  });

  it('reads the channel and model from the source and company', () => {
    const pos = shopifyToInbound({ ...order, source_name: 'pos' });
    const app = shopifyToInbound({ ...order, source_name: 'iphone' });
    const b2b = shopifyToInbound({ ...order, company: { id: 1 } });
    expect(pos.ok && pos.order.channel).toBe('pos');
    expect(app.ok && app.order.channel).toBe('mobile');
    expect(b2b.ok && b2b.order.model).toBe('b2b');
  });

  it('refuses line items without a SKU', () => {
    const r = shopifyToInbound({
      ...order,
      line_items: [{ sku: '', title: 'Gift wrap', quantity: 1, price: '5.00' }],
    });
    expect(r).toEqual({ ok: false, error: 'Line items without a SKU: Gift wrap' });
  });

  it('verifies the webhook HMAC', async () => {
    const body = JSON.stringify(order);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('shpss_test'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    );
    const header = btoa(String.fromCharCode(...mac));
    expect(await verifyShopifyHmac('shpss_test', body, header)).toBe(true);
    expect(await verifyShopifyHmac('shpss_test', `${body} `, header)).toBe(false);
    expect(await verifyShopifyHmac('other', body, header)).toBe(false);
    expect(await verifyShopifyHmac('shpss_test', body, null)).toBe(false);
  });
});

const isa = (el: string, term: string) =>
  `ISA${el}00${el}          ${el}00${el}          ${el}ZZ${el}NORTHWIND      ${el}ZZ${el}ORDERLOOP      ${el}261014${el}1200${el}U${el}00401${el}000000001${el}0${el}P${el}>${term}`;

const po850 = (el: string, term: string, control: string, po: string, lines: string[]) =>
  [
    `ST${el}850${el}${control}`,
    `BEG${el}00${el}SA${el}${po}${el}${el}20261014`,
    `CUR${el}BY${el}USD`,
    `N1${el}ST${el}Northwind Dock 4`,
    `N3${el}500 Harbor Way`,
    `N4${el}Oakland${el}CA${el}94607${el}US`,
    ...lines,
    `CTT${el}${lines.filter((l) => l.startsWith('PO1')).length}`,
    `SE${el}${8 + lines.length}${el}${control}`,
  ].join(term);

const interchange = (el: string, term: string, txs: string[]) =>
  [
    isa(el, term).slice(0, -1),
    `GS${el}PO${el}NORTHWIND${el}ORDERLOOP${el}20261014${el}1200${el}1${el}X${el}004010`,
    ...txs,
    `GE${el}${txs.length}${el}1`,
    `IEA${el}1${el}000000001`,
  ].join(term) + term;

describe('X12 850', () => {
  const lines = (el: string) => [
    `PO1${el}1${el}120${el}EA${el}21.50${el}${el}VP${el}WID-100${el}BP${el}NW-77`,
    `PID${el}F${el}${el}${el}${el}Industrial widget`,
    `PO1${el}2${el}40${el}EA${el}${el}${el}BP${el}GSK-010`,
  ];

  it('parses an interchange with the delimiters its ISA declares', () => {
    for (const [el, term] of [
      ['*', '~'],
      ['|', '\n'],
    ] as const) {
      const p = parseX12(interchange(el, term, [po850(el, term, '0001', 'NW-7781', lines(el))]));
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.interchange.sender).toBe('NORTHWIND');
      expect(p.interchange.transactions.map((t) => [t.type, t.control])).toEqual([['850', '0001']]);
    }
  });

  it('maps an 850 onto a B2B inbound order for the partner', () => {
    const p = parseX12(interchange('*', '~', [po850('*', '~', '0001', 'NW-7781', lines('*'))]));
    if (!p.ok) throw new Error(p.error);
    const r = x12850ToInbound(p.interchange.transactions[0]!, {
      sender: 'NORTHWIND',
      customerId: 'cus_northwind',
    });
    if (!r.ok) throw new Error(r.error);
    expect(inboundOrderSchema.parse(r.order)).toMatchObject({
      model: 'b2b',
      channel: 'edi',
      externalId: 'NORTHWIND:NW-7781',
      source: 'x12-850',
      title: 'PO NW-7781',
      customerId: 'cus_northwind',
      currency: 'USD',
      // VP beats BP; a line without a price keeps no unitPrice, so pricing fills it in.
      lines: [
        { sku: 'WID-100', qty: 120, unitPrice: 21.5, name: 'Industrial widget' },
        { sku: 'GSK-010', qty: 40 },
      ],
      shipTo: {
        name: 'Northwind Dock 4',
        line1: '500 Harbor Way',
        city: 'Oakland',
        region: 'CA',
        postalCode: '94607',
        country: 'US',
      },
    });
  });

  it('splits several purchase orders and checks the counts', () => {
    const two = parseX12(
      interchange('*', '~', [
        po850('*', '~', '0001', 'NW-1', lines('*')),
        po850('*', '~', '0002', 'NW-2', lines('*')),
      ]),
    );
    expect(two.ok && two.interchange.transactions.length).toBe(2);
    const badSe = interchange('*', '~', [po850('*', '~', '0001', 'NW-1', lines('*'))]).replace(
      'SE*11*0001',
      'SE*10*0001',
    );
    expect(parseX12(badSe)).toEqual({
      ok: false,
      error: 'SE for 0001 counts 10 segments; the transaction has 11',
    });
    expect(parseX12('hello')).toMatchObject({ ok: false });
  });

  it('refuses an 850 with no PO number, a bad line count or a line without a part number', () => {
    const tx = (segs: string[]) => ({
      type: '850',
      control: '1',
      segments: segs.map((s) => {
        const [id, ...el] = s.split('*');
        return { id: id!, el };
      }),
    });
    const partner = { sender: 'NORTHWIND', customerId: 'cus_northwind' };
    expect(x12850ToInbound(tx(['PO1*1*1*EA*1**VP*A']), partner)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no BEG03/),
    });
    expect(
      x12850ToInbound(tx(['BEG*00*SA*P1', 'PO1*1*1*EA*1**VP*A', 'CTT*2']), partner),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/CTT says 2/) });
    expect(x12850ToInbound(tx(['BEG*00*SA*P1', 'PO1*1*1*EA*1**ZZ*A']), partner)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no VP, SK, BP or IN/),
    });
  });
});
