import { describe, expect, it } from 'vitest';
import {
  orderMessage,
  parseOrderRequest,
  parseSetupRequest,
  setupResponse,
  statusResponse,
} from '../src/cxml';
import { ociFields, parseOciSetup } from '../src/oci';
import { at, parseXml, XmlError } from '../src/xml';
import orderXml from './fixtures/order-request.xml?raw';
import setupXml from './fixtures/setup-request.xml?raw';

describe('the XML reader', () => {
  it('reads elements, attributes, entities, numeric references and CDATA', () => {
    const el = parseXml(
      '<?xml version="1.0"?><a x="1 &amp; 2"><b>caf&#233; &#x2603;</b><c><![CDATA[<raw & text>]]></c><d/></a>',
    );
    expect(el.attrs.x).toBe('1 & 2');
    expect(at(el, 'b')?.text).toBe('café ☃');
    expect(at(el, 'c')?.text).toBe('<raw & text>');
    expect(at(el, 'd')).toBeDefined();
  });

  it('refuses entity tricks, internal DTD subsets and broken documents', () => {
    const refused = [
      '<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>',
      '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
      '<a>&nbsp;</a>',
      '<a>&toString;</a>',
      '<a>&__proto__;</a>',
      '<a><!-- <![CDATA[ -->&toString;<!-- ]]> --></a>',
      '<a>&#0;</a>',
      '<a><b></a>',
      '<a></a><b/>',
      '<a>',
      'text<a/>',
      `${'<a>'.repeat(70)}${'</a>'.repeat(70)}`,
      `<a>${'x'.repeat(1024 * 1024)}</a>`,
    ];
    for (const xml of refused) expect(() => parseXml(xml), xml.slice(0, 40)).toThrow(XmlError);
  });
});

describe('cXML', () => {
  it('reads a PunchOutSetupRequest', () => {
    const r = parseSetupRequest(setupXml);
    expect(r).toMatchObject({
      payloadId: '1729760000.4321@buyer.example',
      from: [{ domain: 'NetworkID', identity: 'AN01000000001' }],
      sharedSecret: 'SECRET',
      operation: 'create',
      buyerCookie: '34234234ADFSDF234234',
      browserFormPost: 'https://buyer.example/punchout/return?session=1&x=2',
      items: [],
    });
    expect(r.extrinsics.UserFullName).toBe('Ann & Co. Buyer');
  });

  it('reads an OrderRequest', () => {
    const r = parseOrderRequest(orderXml);
    expect(r).toMatchObject({
      payloadId: '1729770000.9876@buyer.example',
      orderId: 'PO-7781',
      type: 'new',
      currency: 'USD',
      total: 107.5,
      shipTo: {
        name: 'Northwind Receiving',
        line1: '1 Harbor Way',
        city: 'Oakland',
        region: 'CA',
        postalCode: '94607',
        country: 'US',
        email: 'receiving@northwind.example',
      },
      items: [
        {
          lineNumber: '1',
          qty: 5,
          sku: 'WID-100',
          aux: 'CARTID:li_1',
          unitPrice: 21.5,
          description: 'Industrial widget',
        },
      ],
    });
  });

  it('refuses a document that is not the request it should be', () => {
    expect(() => parseSetupRequest(orderXml)).toThrow(/PunchOutSetupRequest/);
    expect(() => parseOrderRequest(setupXml)).toThrow(/OrderRequest/);
    expect(() => parseSetupRequest('<cXML><Header/></cXML>')).toThrow();
    expect(() => parseOrderRequest(orderXml.replace('quantity="5"', 'quantity="2.5"'))).toThrow(
      /whole number/,
    );
  });

  it('writes a setup response and statuses with everything escaped', () => {
    const res = parseXml(setupResponse('h', 'https://app.test/cart/start/c/t?a=1&b=<2>'));
    expect(at(res, 'Response/Status')?.attrs.code).toBe('200');
    expect(at(res, 'Response/PunchOutSetupResponse/StartPage/URL')?.text).toBe(
      'https://app.test/cart/start/c/t?a=1&b=<2>',
    );
    const err = parseXml(statusResponse('h', 401, 'No "you" & <me>'));
    expect(at(err, 'Response/Status')?.attrs).toMatchObject({
      code: '401',
      text: 'No "you" & <me>',
    });
  });

  it('writes a PunchOutOrderMessage the buyer’s system can read back', () => {
    const msg = parseXml(
      orderMessage({
        host: 'h',
        from: { domain: 'NetworkID', identity: 'orderloop' },
        to: { domain: 'NetworkID', identity: 'AN01000000001' },
        buyerCookie: 'COOKIE<1>',
        currency: 'USD',
        total: 107.5,
        lines: [
          {
            qty: 5,
            sku: 'WID-100',
            aux: 'cart_1:li_1',
            unitPrice: 21.5,
            description: 'Widget & co',
          },
        ],
      }),
    );
    const poom = at(msg, 'Message/PunchOutOrderMessage');
    expect(at(poom, 'BuyerCookie')?.text).toBe('COOKIE<1>');
    expect(at(poom, 'PunchOutOrderMessageHeader/Total/Money')?.text).toBe('107.50');
    const item = at(poom, 'ItemIn');
    expect(item?.attrs.quantity).toBe('5');
    expect(at(item, 'ItemID/SupplierPartAuxiliaryID')?.text).toBe('cart_1:li_1');
    expect(at(item, 'ItemDetail/Description')?.text).toBe('Widget & co');
    expect(at(item, 'ItemDetail/UnitPrice/Money')?.text).toBe('21.50');
  });
});

describe('OCI', () => {
  it('reads the setup parameters, in either case', () => {
    expect(
      parseOciSetup(
        new URLSearchParams('USERNAME=sap1&PASSWORD=pw&HOOK_URL=https%3A%2F%2Fsap.example%2Fhook'),
      ),
    ).toEqual({ username: 'sap1', password: 'pw', hookUrl: 'https://sap.example/hook' });
    expect(parseOciSetup(new URLSearchParams('username=a&password=b&hook_url=c'))).toEqual({
      username: 'a',
      password: 'b',
      hookUrl: 'c',
    });
    expect(parseOciSetup(new URLSearchParams('USERNAME=a'))).toBeNull();
  });

  it('writes OCI 4.0 fields per line, indexed from 1', () => {
    expect(
      ociFields([
        {
          sku: 'WID-100',
          description: 'Industrial widget',
          qty: 5,
          unitPrice: 21.5,
          currency: 'USD',
          ref: 'cart_1:li_1',
        },
      ]),
    ).toEqual({
      'NEW_ITEM-DESCRIPTION[1]': 'Industrial widget',
      'NEW_ITEM-QUANTITY[1]': '5',
      'NEW_ITEM-UNIT[1]': 'EA',
      'NEW_ITEM-PRICE[1]': '21.50',
      'NEW_ITEM-PRICEUNIT[1]': '1',
      'NEW_ITEM-CURRENCY[1]': 'USD',
      'NEW_ITEM-VENDORMAT[1]': 'WID-100',
      'NEW_ITEM-EXT_PRODUCT_ID[1]': 'cart_1:li_1',
    });
  });
});
