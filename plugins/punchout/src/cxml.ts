/**
 * cXML 1.2 punchout, as far as a supplier needs it: reading a buyer's PunchOutSetupRequest and
 * OrderRequest, and writing the PunchOutSetupResponse, the PunchOutOrderMessage that returns the
 * cart, and status Responses. See https://cxml.org.
 */

import { at, child, children, esc, parseXml, type XmlElement } from './xml';

export const CXML_DOCTYPE =
  '<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.069/cXML.dtd">';

export type Credential = { domain: string; identity: string };

export type CxmlHeader = {
  payloadId: string;
  from: Credential[];
  to: Credential[];
  sender: Credential[];
  /** The shared secret on the Sender's credential, if any. */
  sharedSecret: string | null;
};

export type SetupRequest = CxmlHeader & {
  operation: 'create' | 'edit' | 'inspect';
  buyerCookie: string;
  browserFormPost: string;
  extrinsics: Record<string, string>;
  /** Lines the buyer's system sends back for an `edit` or `inspect`. */
  items: { sku: string; aux: string | null; qty: number }[];
};

export type OrderLine = {
  lineNumber: string;
  qty: number;
  sku: string;
  aux: string | null;
  unitPrice: number | null;
  description: string | null;
};

export type OrderAddress = {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  email?: string;
  phone?: string;
};

export type OrderRequest = CxmlHeader & {
  orderId: string;
  orderDate: string | null;
  type: string;
  currency: string;
  total: number | null;
  shipTo: OrderAddress | null;
  items: OrderLine[];
};

export class CxmlError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const credentials = (el: XmlElement | undefined) =>
  children(el, 'Credential').map((c) => ({
    domain: c.attrs.domain ?? '',
    identity: child(c, 'Identity')?.text ?? '',
  }));

function header(root: XmlElement): CxmlHeader {
  if (root.name !== 'cXML') throw new CxmlError('Not a cXML document');
  const h = child(root, 'Header');
  if (!h) throw new CxmlError('The document has no Header');
  const sender = child(h, 'Sender');
  const secret = children(sender, 'Credential')
    .map((c) => child(c, 'SharedSecret')?.text)
    .find((s) => s);
  return {
    payloadId: root.attrs.payloadID ?? '',
    from: credentials(child(h, 'From')),
    to: credentials(child(h, 'To')),
    sender: credentials(sender),
    sharedSecret: secret ?? null,
  };
}

const quantity = (raw: string | undefined) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n))
    throw new CxmlError(`Quantity “${raw ?? ''}” is not a whole number`);
  return n;
};

const money = (el: XmlElement | undefined) => {
  const m = child(el, 'Money');
  const n = m ? Number(m.text) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseSetupRequest(xml: string): SetupRequest {
  const root = parseXml(xml);
  const h = header(root);
  const req = at(root, 'Request/PunchOutSetupRequest');
  if (!req) throw new CxmlError('Not a PunchOutSetupRequest');
  const operation = (req.attrs.operation ?? 'create') as SetupRequest['operation'];
  if (!['create', 'edit', 'inspect'].includes(operation))
    throw new CxmlError(`Operation “${operation}” is not supported`);
  const buyerCookie = child(req, 'BuyerCookie')?.text ?? '';
  const browserFormPost = at(req, 'BrowserFormPost/URL')?.text ?? '';
  if (!buyerCookie) throw new CxmlError('The request has no BuyerCookie');
  if (!browserFormPost) throw new CxmlError('The request has no BrowserFormPost URL');
  const extrinsics = Object.fromEntries(
    children(req, 'Extrinsic').map((e) => [e.attrs.name ?? '', e.text]),
  );
  const items = children(req, 'ItemOut').map((it) => ({
    sku: at(it, 'ItemID/SupplierPartID')?.text ?? '',
    aux: at(it, 'ItemID/SupplierPartAuxiliaryID')?.text || null,
    qty: quantity(it.attrs.quantity),
  }));
  return { ...h, operation, buyerCookie, browserFormPost, extrinsics, items };
}

function address(el: XmlElement | undefined): OrderAddress | null {
  const a = child(el, 'Address');
  if (!a) return null;
  const postal = child(a, 'PostalAddress');
  const streets = children(postal, 'Street').map((s) => s.text);
  const out: OrderAddress = {
    name: child(a, 'Name')?.text || child(postal, 'DeliverTo')?.text || undefined,
    line1: streets[0],
    line2: streets[1],
    city: child(postal, 'City')?.text,
    region: child(postal, 'State')?.text,
    postalCode: child(postal, 'PostalCode')?.text,
    country: child(postal, 'Country')?.attrs.isoCountryCode,
    email: child(a, 'Email')?.text,
    phone: at(a, 'Phone/TelephoneNumber/Number')?.text,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as OrderAddress;
}

export function parseOrderRequest(xml: string): OrderRequest {
  const root = parseXml(xml);
  const h = header(root);
  const req = at(root, 'Request/OrderRequest');
  if (!req) throw new CxmlError('Not an OrderRequest');
  const oh = child(req, 'OrderRequestHeader');
  if (!oh?.attrs.orderID) throw new CxmlError('The order has no orderID');
  const total = child(oh, 'Total');
  const items = children(req, 'ItemOut').map((it, i) => {
    const sku = at(it, 'ItemID/SupplierPartID')?.text ?? '';
    if (!sku) throw new CxmlError(`Line ${i + 1} has no SupplierPartID`);
    return {
      lineNumber: it.attrs.lineNumber ?? String(i + 1),
      qty: quantity(it.attrs.quantity),
      sku,
      aux: at(it, 'ItemID/SupplierPartAuxiliaryID')?.text || null,
      unitPrice: money(at(it, 'ItemDetail/UnitPrice')),
      description: at(it, 'ItemDetail/Description')?.text || null,
    };
  });
  if (!items.length) throw new CxmlError('The order has no lines');
  return {
    ...h,
    orderId: oh.attrs.orderID,
    orderDate: oh.attrs.orderDate ?? null,
    type: oh.attrs.type ?? 'new',
    currency: child(total, 'Money')?.attrs.currency ?? 'USD',
    total: money(total),
    shipTo: address(child(oh, 'ShipTo')),
    items,
  };
}

/** A payload id for a document we send. */
export const payloadId = (host: string) =>
  `${Date.now()}.${crypto.randomUUID().slice(0, 8)}@${host}`;

const stamp = () => new Date().toISOString();

const document = (payload: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n${CXML_DOCTYPE}\n<cXML payloadID="${esc(payload)}" timestamp="${stamp()}" xml:lang="en-US">${body}</cXML>`;

/** A status Response (200 OK, or the error a request earned). */
export function statusResponse(host: string, code: number, text: string, detail = ''): string {
  return document(
    payloadId(host),
    `<Response><Status code="${code}" text="${esc(text)}">${esc(detail)}</Status></Response>`,
  );
}

export function setupResponse(host: string, startUrl: string): string {
  return document(
    payloadId(host),
    `<Response><Status code="200" text="OK"/><PunchOutSetupResponse><StartPage><URL>${esc(startUrl)}</URL></StartPage></PunchOutSetupResponse></Response>`,
  );
}

const amount = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

const credential = (c: Credential) =>
  `<Credential domain="${esc(c.domain)}"><Identity>${esc(c.identity)}</Identity></Credential>`;

export type OrderMessageLine = {
  qty: number;
  sku: string;
  aux: string;
  unitPrice: number;
  description: string;
  unit?: string;
};

/**
 * The cart as the buyer's system takes it back: a PunchOutOrderMessage, posted as the
 * `cxml-urlencoded` form field to the session's BrowserFormPost URL.
 */
export function orderMessage(o: {
  host: string;
  from: Credential;
  to: Credential;
  buyerCookie: string;
  currency: string;
  total: number;
  lines: OrderMessageLine[];
}): string {
  const items = o.lines
    .map(
      (l) =>
        `<ItemIn quantity="${l.qty}"><ItemID><SupplierPartID>${esc(l.sku)}</SupplierPartID><SupplierPartAuxiliaryID>${esc(l.aux)}</SupplierPartAuxiliaryID></ItemID><ItemDetail><UnitPrice><Money currency="${esc(o.currency)}">${amount(l.unitPrice)}</Money></UnitPrice><Description xml:lang="en-US">${esc(l.description)}</Description><UnitOfMeasure>${esc(l.unit ?? 'EA')}</UnitOfMeasure></ItemDetail></ItemIn>`,
    )
    .join('');
  return document(
    payloadId(o.host),
    `<Header><From>${credential(o.from)}</From><To>${credential(o.to)}</To><Sender>${credential(o.from)}<UserAgent>OrderLoop</UserAgent></Sender></Header><Message><PunchOutOrderMessage><BuyerCookie>${esc(o.buyerCookie)}</BuyerCookie><PunchOutOrderMessageHeader operationAllowed="edit"><Total><Money currency="${esc(o.currency)}">${amount(o.total)}</Money></Total></PunchOutOrderMessageHeader>${items}</PunchOutOrderMessage></Message>`,
  );
}
