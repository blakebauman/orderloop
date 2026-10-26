/**
 * Carts: a list of lines that several people build together before it becomes an order. Staff
 * open one from the Carts page; a plugin (punchout) opens an external one for a buyer it has
 * already authenticated, who then returns it to their own system. Pure: the engine's CartAgent
 * holds a cart, applies ops to it one at a time and prices it with the flow's pricing nodes
 * (`quoteNodes`), the same way a checkout is priced.
 *
 * Nobody sets a price on a cart. A line is a SKU and a quantity; the quote says what it costs, and
 * a quote is current only for the version it was worked out for. A cart that ships is quoted for
 * its ship-to and shipping option, which its order then adopts, as a checkout's does.
 */

import { z } from 'zod';
import type { ShipAddress } from './address';
import {
  applyLines,
  type CheckoutIssue,
  type CheckoutLine,
  type CheckoutQuote,
  isCompleteAddress,
  MAX_CHECKOUT_LINES,
  MAX_LINE_QUANTITY,
} from './checkout';
import { atLeast, type Principal, type Role } from './roles';

export const CART_STATUSES = ['open', 'locked', 'submitted', 'returned', 'canceled'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

/** Statuses a cart never leaves: it became an order, went back to the buyer's system, or ended. */
export const FINAL_CART_STATUSES: readonly CartStatus[] = ['submitted', 'returned', 'canceled'];

export const MAX_CART_TITLE = 120;
export const MAX_PROMO_CODES = 5;
export const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
export const MAX_CHAT_BODY = 4_000;

/**
 * Who is acting on a cart. Staff come from the signed principal; a guest is the buyer an external
 * cart was opened for, admitted only to that cart.
 */
export type CartActor =
  | { kind: 'staff'; id: string; name: string; role: Role }
  | { kind: 'guest'; id: string; name: string };

/** Staff acting on a cart: what the REST API, MCP and the assistant act as, never a guest. */
export type StaffCartActor = Extract<CartActor, { kind: 'staff' }>;

/** The principal as they act on a cart, built by the server that resolved them. */
export const staffCartActor = (p: Pick<Principal, 'id' | 'name' | 'role'>): StaffCartActor => ({
  kind: 'staff',
  id: p.id,
  name: p.name,
  role: p.role,
});

/** Set when a plugin opened the cart for a buyer outside OrderLoop. */
export type ExternalCart = {
  pluginId: string;
  /** The plugin's own id for the session (a punchout BuyerCookie, say); unique per plugin. */
  sessionRef: string;
  expiresAt: number;
  /** Where the cart goes back to: its return is posted here, and nowhere else. */
  returnUrl: string;
  /** Origins that may frame the cart's pages. */
  frameOrigins: string[];
  /** The buyer it was opened for, as the plugin authenticated them. */
  buyer: { id: string; name: string };
};

export type Cart = {
  id: string;
  title: string;
  status: CartStatus;
  customerId: string | null;
  /** The flow the cart is priced by and, once submitted, ordered through. */
  flowId: string;
  external: ExternalCart | null;
  lines: CheckoutLine[];
  promoCodes: string[];
  /** Where it ships: priced by the flow's shipping and tax nodes, and the order's `meta.shipTo`. */
  shipTo: Partial<ShipAddress> | null;
  /** The option chosen from the quote's `shippingOptions`; null lets the flow pick. */
  shippingOption: string | null;
  quote: CheckoutQuote | null;
  /** The cart version the quote was worked out for. */
  quotedVersion: number;
  issues: CheckoutIssue[];
  /** The order submitting it started. */
  orderId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every change, so a quote and a submit can tell they are about this cart as it is. */
  version: number;
};

export type CartOp =
  | { op: 'add'; sku: string; qty: number }
  | { op: 'set_qty'; lineId: string; qty: number }
  | { op: 'remove'; lineIds: string[] }
  | { op: 'clear' }
  | { op: 'lock' }
  | { op: 'unlock' }
  | { op: 'promo_add'; code: string }
  | { op: 'promo_remove'; code: string }
  | { op: 'rename'; title: string }
  /** null clears the address, and the option with it. */
  | { op: 'set_ship_to'; address: Partial<ShipAddress> | null }
  | { op: 'set_shipping_option'; option: string | null };

/** The longest each ship-to field may be, as an inbound order's address bounds them. */
export const SHIP_TO_LIMITS: Record<keyof ShipAddress, number> = {
  name: 120,
  line1: 200,
  line2: 200,
  city: 100,
  region: 100,
  postalCode: 20,
  country: 60,
};
export const MAX_SHIPPING_OPTION_ID = 80;

const shipToField = (f: keyof ShipAddress) => z.string().trim().max(SHIP_TO_LIMITS[f]).optional();
const shipToSchema = z.object({
  name: shipToField('name'),
  line1: shipToField('line1'),
  line2: shipToField('line2'),
  city: shipToField('city'),
  region: shipToField('region'),
  postalCode: shipToField('postalCode'),
  country: shipToField('country'),
});

/**
 * A `CartOp` as a caller outside the cart's page sends it (the REST API, MCP, the assistant).
 * Shapes and bounds only; `applyCartOp` decides whether the cart takes it.
 */
export const cartOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    sku: z.string().trim().min(1).max(120),
    qty: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  }),
  z.object({
    op: z.literal('set_qty'),
    lineId: z.string().min(1).max(100),
    qty: z.number().int().min(0).max(MAX_LINE_QUANTITY).describe('0 removes the line'),
  }),
  z.object({
    op: z.literal('remove'),
    lineIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_CHECKOUT_LINES),
  }),
  z.object({ op: z.literal('clear') }),
  z.object({ op: z.literal('lock') }),
  z.object({ op: z.literal('unlock') }),
  z.object({ op: z.literal('promo_add'), code: z.string().min(1).max(40) }),
  z.object({ op: z.literal('promo_remove'), code: z.string().min(1).max(40) }),
  z.object({ op: z.literal('rename'), title: z.string().min(1).max(MAX_CART_TITLE) }),
  z.object({
    op: z.literal('set_ship_to'),
    address: shipToSchema
      .nullable()
      .describe('line1, city, postalCode and country make it complete; null clears it'),
  }),
  z.object({
    op: z.literal('set_shipping_option'),
    option: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SHIPPING_OPTION_ID)
      .nullable()
      .describe("An id from the quote's shippingOptions; null lets the flow pick"),
  }),
]) satisfies z.ZodType<CartOp>;

export type CartOpResult =
  | { ok: true; cart: Cart; reprice: boolean }
  | { ok: false; error: string };

/** What submitting refuses when the cart changed after the person saw what they confirmed. */
export const CART_CHANGED_SINCE_CONFIRM = 'The cart changed since you confirmed; preview it again.';

export const isFinalCart = (c: Pick<Cart, 'status'>) => FINAL_CART_STATUSES.includes(c.status);

export const isExternalCart = (c: Pick<Cart, 'external'>) => c.external !== null;

/** Whether the cart's quote prices the cart as it is now. */
export const isQuoteCurrent = (c: Pick<Cart, 'quote' | 'quotedVersion' | 'version'>) =>
  c.quote !== null && c.quotedVersion === c.version;

export const isCartExpired = (c: Pick<Cart, 'external' | 'status'>, now: number) =>
  !isFinalCart(c) && c.external !== null && c.external.expiresAt <= now;

/** Whether `actor` may read the cart. A guest sees only an external cart it was admitted to. */
export function canReadCart(c: Pick<Cart, 'external'>, actor: CartActor): boolean {
  return actor.kind === 'staff' ? atLeast(actor.role, 'viewer') : c.external !== null;
}

/** Whether `actor` may change the cart's lines and promo codes. */
export function canEditCart(c: Pick<Cart, 'external'>, actor: CartActor): boolean {
  return actor.kind === 'staff' ? atLeast(actor.role, 'operator') : c.external !== null;
}

/** Normalises a promo code as people type it (` welcome15 ` is `WELCOME15`), or null if it can't be one. */
export function normalizePromoCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return PROMO_CODE_RE.test(code) ? code : null;
}

/**
 * A ship-to as a cart stores it: known fields only, trimmed, empty ones dropped; null when a field
 * isn't text or is too long, or nothing is left. The socket's ops never pass `cartOpSchema`, so
 * the cart bounds them itself.
 */
export function cartShipTo(raw: unknown): Partial<ShipAddress> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Partial<ShipAddress> = {};
  for (const [f, max] of Object.entries(SHIP_TO_LIMITS) as [keyof ShipAddress, number][]) {
    const v = (raw as Record<string, unknown>)[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (t.length > max) return null;
    if (t) out[f] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** A stored cart, with what a cart from before ship-to lacks read as unset. */
export const storedCart = (c: Cart): Cart => ({
  ...c,
  shipTo: c.shipTo ?? null,
  shippingOption: c.shippingOption ?? null,
});

const validQty = (qty: number) => Number.isInteger(qty) && qty >= 0 && qty <= MAX_LINE_QUANTITY;
const validSku = (sku: string) => sku.trim().length > 0 && sku.length <= 120;

/**
 * Applies one op, or says why it can't. Lines and promo codes change only on an open cart; lock,
 * unlock and rename are staff's. A cart that changes gets a new version, and `reprice` says
 * whether its quote is now stale. Adding a SKU the cart already has adds to that line, and a
 * quantity of 0 removes the line.
 */
export function applyCartOp(cart: Cart, op: CartOp, actor: CartActor, now: number): CartOpResult {
  const fail = (error: string): CartOpResult => ({ ok: false, error });
  if (isFinalCart(cart)) return fail(`The cart is ${cart.status}.`);
  if (!canEditCart(cart, actor)) return fail("You can't change this cart.");
  // A change that doesn't touch lines or codes keeps a current quote current.
  const done = (patch: Partial<Cart>, reprice: boolean): CartOpResult => ({
    ok: true,
    cart: {
      ...cart,
      ...patch,
      updatedAt: now,
      version: cart.version + 1,
      quotedVersion:
        !reprice && cart.quotedVersion === cart.version ? cart.version + 1 : cart.quotedVersion,
    },
    reprice,
  });

  if (op.op === 'lock' || op.op === 'unlock' || op.op === 'rename') {
    if (actor.kind !== 'staff') return fail('Only staff can do that.');
    if (op.op === 'rename') {
      const title = op.title.trim();
      if (!title || title.length > MAX_CART_TITLE)
        return fail(`A title is 1 to ${MAX_CART_TITLE} characters.`);
      return done({ title }, false);
    }
    const status = op.op === 'lock' ? 'locked' : 'open';
    if (cart.status === status) return fail(`The cart is already ${status}.`);
    return done({ status }, false);
  }

  if (cart.status === 'locked') return fail('The cart is locked.');

  switch (op.op) {
    case 'add': {
      const sku = op.sku.trim();
      if (!validSku(sku)) return fail('Give a SKU.');
      if (!validQty(op.qty) || op.qty === 0)
        return fail(`A quantity is 1 to ${MAX_LINE_QUANTITY}.`);
      const existing = cart.lines.find((l) => l.sku === sku);
      if (existing) {
        const qty = existing.qty + op.qty;
        if (qty > MAX_LINE_QUANTITY) return fail(`A line holds at most ${MAX_LINE_QUANTITY}.`);
        return done({ lines: cart.lines.map((l) => (l === existing ? { ...l, qty } : l)) }, true);
      }
      if (cart.lines.length >= MAX_CHECKOUT_LINES)
        return fail(`A cart holds at most ${MAX_CHECKOUT_LINES} lines.`);
      return done({ lines: applyLines(cart.lines, [...cart.lines, { sku, qty: op.qty }]) }, true);
    }
    case 'set_qty': {
      if (!validQty(op.qty)) return fail(`A quantity is 0 to ${MAX_LINE_QUANTITY}.`);
      if (!cart.lines.some((l) => l.id === op.lineId)) return fail('That line is gone.');
      const lines =
        op.qty === 0
          ? cart.lines.filter((l) => l.id !== op.lineId)
          : cart.lines.map((l) => (l.id === op.lineId ? { ...l, qty: op.qty } : l));
      return done({ lines }, true);
    }
    case 'remove': {
      const drop = new Set(op.lineIds);
      const lines = cart.lines.filter((l) => !drop.has(l.id));
      if (lines.length === cart.lines.length) return fail('Those lines are gone.');
      return done({ lines }, true);
    }
    case 'clear':
      if (!cart.lines.length) return fail('The cart is empty.');
      return done({ lines: [] }, true);
    case 'promo_add': {
      const code = normalizePromoCode(op.code);
      if (!code) return fail('That is not a promo code.');
      if (cart.promoCodes.includes(code)) return fail(`${code} is already applied.`);
      if (cart.promoCodes.length >= MAX_PROMO_CODES)
        return fail(`A cart takes at most ${MAX_PROMO_CODES} codes.`);
      return done({ promoCodes: [...cart.promoCodes, code] }, true);
    }
    case 'promo_remove': {
      const code = normalizePromoCode(op.code);
      if (!code || !cart.promoCodes.includes(code)) return fail('That code is not applied.');
      return done({ promoCodes: cart.promoCodes.filter((c) => c !== code) }, true);
    }
    case 'set_ship_to': {
      if (op.address === null) {
        if (!cart.shipTo && !cart.shippingOption) return fail('The cart has no ship-to.');
        // An option is offered for an address; with none, the flow picks again.
        return done({ shipTo: null, shippingOption: null }, true);
      }
      const shipTo = cartShipTo(op.address);
      if (!shipTo) return fail('Give an address: street, city, postcode and country.');
      return done({ shipTo }, true);
    }
    case 'set_shipping_option': {
      if (op.option === null) {
        if (!cart.shippingOption) return fail('No shipping option is chosen.');
        return done({ shippingOption: null }, true);
      }
      const option = typeof op.option === 'string' ? op.option.trim() : '';
      if (!option || option.length > MAX_SHIPPING_OPTION_ID)
        return fail('Choose a shipping option.');
      // Checked against a quote only while it prices the cart; otherwise the next quote says.
      if (isQuoteCurrent(cart)) {
        const offered = cart.quote!.shippingOptions;
        if (!offered.length) return fail('This cart’s flow offers no shipping options.');
        if (!offered.some((o) => o.id === option))
          return fail(`The shipping option “${option}” is not offered.`);
      }
      return done({ shippingOption: option }, true);
    }
  }
}

/**
 * Why the cart can't be submitted as an order or returned to the buyer's system yet, or null when
 * it can: it has lines, its quote is for this version, the quote found no errors, and when it
 * ships by a flow that offers shipping options, it has a complete ship-to. A cart whose flow
 * prices no shipping, that ships nothing, or that goes back to a buyer's system needs no address.
 */
export function cartReadyProblem(cart: Cart): string | null {
  if (isFinalCart(cart)) return `The cart is ${cart.status}.`;
  if (!cart.lines.length) return 'Add at least one line.';
  if (cart.quotedVersion !== cart.version) return 'The cart is being priced.';
  const error = cart.issues.find((i) => i.kind === 'error');
  if (error) return error.content;
  const q = cart.quote;
  if (!q) return 'The cart could not be priced.';
  // An external cart goes back to the buyer's system without its address: their purchase order
  // says where it ships.
  if (!cart.external && q.ships && q.shippingOptions.length && !isCompleteAddress(cart.shipTo))
    return 'Add a complete ship-to address: street, city, postcode and country.';
  return null;
}

/**
 * The option the cart ships by: while its quote is current, the one the quote charged (the flow's
 * shipping step may pick the cheapest or fastest whatever was chosen); before that, the chosen one.
 */
export const cartShippingOption = (cart: Cart): string | null =>
  isQuoteCurrent(cart) ? cart.quote!.shippingOption : (cart.shippingOption ?? null);

/**
 * A staff cart as the REST API and MCP show it: its lines, quote and problems, without its chat,
 * files or the people who have it open, which stay on the cart's page.
 */
export type CartView = Omit<Cart, 'external' | 'quotedVersion'> & {
  /** Whether `quote` prices the cart as it is now. */
  quoteCurrent: boolean;
  /** Why it can't be submitted yet (`cartReadyProblem`); null when it can. */
  notReady: string | null;
};

export function cartView(cart: Cart): CartView {
  const { external: _external, quotedVersion: _quoted, ...rest } = cart;
  return { ...rest, quoteCurrent: isQuoteCurrent(cart), notReady: cartReadyProblem(cart) };
}

/** Ends the cart: `submitted` (staff, into an order) or `returned` (external, to the buyer's system). */
export function finishCart(
  cart: Cart,
  how: { status: 'submitted'; orderId: string } | { status: 'returned' } | { status: 'canceled' },
  now: number,
): Cart {
  return {
    ...cart,
    status: how.status,
    orderId: how.status === 'submitted' ? how.orderId : cart.orderId,
    updatedAt: now,
    version: cart.version + 1,
    // Ending the cart changes nothing it was priced on.
    quotedVersion: cart.quotedVersion === cart.version ? cart.version + 1 : cart.quotedVersion,
  };
}

export type CartChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  at: number;
  editedAt: number | null;
};

/** A message body as it is stored: trimmed, 1 to `MAX_CHAT_BODY` characters; null if it can't be one. */
export function chatBody(raw: string): string | null {
  const body = raw.trim();
  return body && body.length <= MAX_CHAT_BODY ? body : null;
}

/** Only a message's author changes or deletes it. */
export const canChangeMessage = (m: Pick<CartChatMessage, 'authorId'>, actor: CartActor) =>
  m.authorId === actor.id;

/** Someone with the cart open now. */
export type CartMember = { id: string; name: string; kind: CartActor['kind'] };

/** Chat messages the synced state carries; older ones are read a page at a time. */
export const CART_CHAT_BROADCAST = 50;

/** What a cart's agent syncs to everyone who has it open. */
export type CartState = {
  cart: Cart | null;
  members: CartMember[];
  /** The newest `CART_CHAT_BROADCAST` messages, oldest first. */
  chat: CartChatMessage[];
  /** Files on the cart, oldest first (absent on a cart from before attachments). */
  attachments?: CartAttachment[];
};

export const EMPTY_CART_STATE: CartState = { cart: null, members: [], chat: [], attachments: [] };

/** Files a cart holds, and how big each may be. */
export const MAX_CART_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The file types a cart takes, by media type. Nothing that a browser would run. */
export const ATTACHMENT_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
  'text/csv': 'CSV',
  'text/plain': 'Text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel workbook',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
};

/** A file someone added to a cart: a spec sheet, a quote request, a photo. */
export type CartAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Where it is in the documents bucket: `carts/<cartId>/<id>` (`cartAttachmentKey`). */
  key: string;
  by: { id: string; name: string };
  at: number;
};

/** Where a cart's file lives in the documents bucket, beside the bucket's `orders/` and `audit/`. */
export const cartAttachmentKey = (cartId: string, id: string) => `carts/${cartId}/${id}`;

/** Every file a cart holds, as a bucket prefix. */
export const cartAttachmentPrefix = (cartId: string) => `carts/${cartId}/`;

/** A file name as stored and shown: no path, no control characters, at most 120 characters. */
export function attachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (clean || 'file').slice(-120);
}

/** Why a file can't go on a cart, or null. */
export function attachmentProblem(f: { type: string; size: number }, count: number): string | null {
  if (!(f.type in ATTACHMENT_TYPES))
    return 'Attach a PDF, an image (PNG, JPEG, WebP), a CSV or text file, or an Excel or Word file.';
  if (f.size <= 0) return 'The file is empty.';
  if (f.size > MAX_ATTACHMENT_BYTES) return 'A file is at most 10 MB.';
  if (count >= MAX_CART_ATTACHMENTS) return `A cart holds at most ${MAX_CART_ATTACHMENTS} files.`;
  return null;
}

/** Who may remove a file: whoever added it, or staff who may change the cart. */
export const canRemoveAttachment = (a: Pick<CartAttachment, 'by'>, actor: CartActor) =>
  a.by.id === actor.id || (actor.kind === 'staff' && atLeast(actor.role, 'operator'));

/** What a staff cart starts with; the engine checks the flow and the customer. */
/** A cart as it starts: open, unpriced, at version 1, shipping nowhere yet. */
export function newCart(c: {
  id: string;
  title: string;
  flowId: string;
  customerId: string | null;
  external: ExternalCart | null;
  lines: CheckoutLine[];
  createdBy: string;
  now: number;
}): Cart {
  return {
    id: c.id,
    title: c.title,
    status: 'open',
    customerId: c.customerId,
    flowId: c.flowId,
    external: c.external,
    lines: c.lines,
    promoCodes: [],
    shipTo: null,
    shippingOption: null,
    quote: null,
    quotedVersion: 0,
    issues: [],
    orderId: null,
    createdBy: c.createdBy,
    createdAt: c.now,
    updatedAt: c.now,
    version: 1,
  };
}

export type CreateCartInput = {
  title: string;
  flowId: string;
  customerId?: string | null;
  /** The principal id creating it, set by the caller's server. */
  createdBy: string;
};
