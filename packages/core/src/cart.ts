/**
 * Carts: a list of lines that several people build together before it becomes an order. Staff
 * open one from the Carts page; a plugin (punchout) opens an external one for a buyer it has
 * already authenticated, who then returns it to their own system. Pure: the engine's CartAgent
 * holds a cart, applies ops to it one at a time and prices it with the flow's pricing nodes
 * (`quoteNodes`), the same way a checkout is priced.
 *
 * Nobody sets a price on a cart. A line is a SKU and a quantity; the quote says what it costs, and
 * a quote is current only for the version it was worked out for.
 */

import {
  applyLines,
  type CheckoutIssue,
  type CheckoutLine,
  type CheckoutQuote,
  MAX_CHECKOUT_LINES,
  MAX_LINE_QUANTITY,
} from './checkout';
import { atLeast, type Role } from './roles';

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

/** Set when a plugin opened the cart for a buyer outside OrderLoop. */
export type ExternalCart = {
  pluginId: string;
  /** The plugin's own id for the session (a punchout BuyerCookie, say); unique per plugin. */
  sessionRef: string;
  expiresAt: number;
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
  | { op: 'rename'; title: string };

export type CartOpResult =
  | { ok: true; cart: Cart; reprice: boolean }
  | { ok: false; error: string };

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
  }
}

/**
 * Why the cart can't be submitted as an order or returned to the buyer's system yet, or null when
 * it can: it has lines, its quote is for this version, and the quote found no errors.
 */
export function cartReadyProblem(cart: Cart): string | null {
  if (isFinalCart(cart)) return `The cart is ${cart.status}.`;
  if (!cart.lines.length) return 'Add at least one line.';
  if (cart.quotedVersion !== cart.version) return 'The cart is being priced.';
  const error = cart.issues.find((i) => i.kind === 'error');
  if (error) return error.content;
  return cart.quote ? null : 'The cart could not be priced.';
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
};

export const EMPTY_CART_STATE: CartState = { cart: null, members: [], chat: [] };

/** What a staff cart starts with; the engine checks the flow and the customer. */
export type CreateCartInput = {
  title: string;
  flowId: string;
  customerId?: string | null;
  /** The principal id creating it, set by the caller's server. */
  createdBy: string;
};
