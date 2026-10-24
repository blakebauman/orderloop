import { describe, expect, it } from 'vitest';
import {
  applyCartOp,
  type Cart,
  type CartActor,
  type CartOp,
  canChangeMessage,
  canEditCart,
  canReadCart,
  cartReadyProblem,
  chatBody,
  finishCart,
  isCartExpired,
  isQuoteCurrent,
  MAX_CHAT_BODY,
  MAX_CHECKOUT_LINES,
  MAX_LINE_QUANTITY,
  MAX_PROMO_CODES,
  normalizePromoCode,
} from '../src';

const cart = (c: Partial<Cart> = {}): Cart => ({
  id: 'cart_1',
  title: 'Q4 restock',
  status: 'open',
  customerId: null,
  flowId: 'flow_1',
  external: null,
  lines: [{ id: 'li_1', sku: 'SKU-1', qty: 2 }],
  promoCodes: [],
  quote: null,
  quotedVersion: 0,
  issues: [],
  orderId: null,
  createdBy: 'usr_1',
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  ...c,
});

const external = { pluginId: 'punchout', sessionRef: 'cookie-1', expiresAt: 1_000 };
const operator: CartActor = { kind: 'staff', id: 'usr_1', name: 'Ada', role: 'operator' };
const viewer: CartActor = { kind: 'staff', id: 'usr_2', name: 'Bo', role: 'viewer' };
const guest: CartActor = { kind: 'guest', id: 'buyer_1', name: 'Cy' };

const quote = {
  currency: 'USD',
  lines: [],
  subtotal: 10,
  shipping: 0,
  tax: 0,
  total: 10,
  shippingOptions: [],
  shippingOption: null,
  ships: false,
};

function apply(c: Cart, op: CartOp, actor: CartActor = operator) {
  const r = applyCartOp(c, op, actor, 50);
  if (!r.ok) throw new Error(r.error);
  return r;
}

function refuse(c: Cart, op: CartOp, actor: CartActor = operator) {
  const r = applyCartOp(c, op, actor, 50);
  if (r.ok) throw new Error(`expected ${op.op} to be refused`);
  return r.error;
}

describe('cart access', () => {
  it('lets staff read from viewer and edit from operator', () => {
    expect(canReadCart(cart(), viewer)).toBe(true);
    expect(canEditCart(cart(), viewer)).toBe(false);
    expect(canEditCart(cart(), operator)).toBe(true);
  });

  it('admits a guest only to an external cart', () => {
    expect(canReadCart(cart(), guest)).toBe(false);
    expect(canEditCart(cart(), guest)).toBe(false);
    expect(canReadCart(cart({ external }), guest)).toBe(true);
    expect(canEditCart(cart({ external }), guest)).toBe(true);
  });
});

describe('applyCartOp', () => {
  it('adds a new SKU as a new line and bumps the version', () => {
    const r = apply(cart(), { op: 'add', sku: ' SKU-2 ', qty: 3 });
    expect(r.cart.lines).toEqual([
      { id: 'li_1', sku: 'SKU-1', qty: 2 },
      { id: 'li_2', sku: 'SKU-2', qty: 3 },
    ]);
    expect(r.cart.version).toBe(2);
    expect(r.cart.updatedAt).toBe(50);
    expect(r.reprice).toBe(true);
  });

  it('adds to the line that already has the SKU', () => {
    const r = apply(cart(), { op: 'add', sku: 'SKU-1', qty: 3 });
    expect(r.cart.lines).toEqual([{ id: 'li_1', sku: 'SKU-1', qty: 5 }]);
  });

  it('keeps line quantities whole and within the limit', () => {
    expect(refuse(cart(), { op: 'add', sku: 'SKU-2', qty: 0 })).toMatch(/quantity/);
    expect(refuse(cart(), { op: 'add', sku: 'SKU-2', qty: 1.5 })).toMatch(/quantity/);
    expect(refuse(cart(), { op: 'add', sku: 'SKU-2', qty: -1 })).toMatch(/quantity/);
    expect(refuse(cart(), { op: 'add', sku: 'SKU-1', qty: MAX_LINE_QUANTITY })).toMatch(/at most/);
    expect(refuse(cart(), { op: 'set_qty', lineId: 'li_1', qty: -1 })).toMatch(/quantity/);
    expect(refuse(cart(), { op: 'add', sku: '  ', qty: 1 })).toMatch(/SKU/);
  });

  it('caps the number of lines', () => {
    const lines = Array.from({ length: MAX_CHECKOUT_LINES }, (_, i) => ({
      id: `li_${i + 1}`,
      sku: `SKU-${i + 1}`,
      qty: 1,
    }));
    expect(refuse(cart({ lines }), { op: 'add', sku: 'NEW', qty: 1 })).toMatch(/lines/);
  });

  it('sets a quantity, and removes the line at 0', () => {
    expect(apply(cart(), { op: 'set_qty', lineId: 'li_1', qty: 7 }).cart.lines[0]?.qty).toBe(7);
    expect(apply(cart(), { op: 'set_qty', lineId: 'li_1', qty: 0 }).cart.lines).toEqual([]);
    expect(refuse(cart(), { op: 'set_qty', lineId: 'li_9', qty: 1 })).toMatch(/gone/);
  });

  it('removes lines in bulk and clears', () => {
    const c = cart({
      lines: [
        { id: 'li_1', sku: 'A', qty: 1 },
        { id: 'li_2', sku: 'B', qty: 1 },
        { id: 'li_3', sku: 'C', qty: 1 },
      ],
    });
    expect(
      apply(c, { op: 'remove', lineIds: ['li_1', 'li_3'] }).cart.lines.map((l) => l.sku),
    ).toEqual(['B']);
    expect(refuse(c, { op: 'remove', lineIds: ['li_9'] })).toMatch(/gone/);
    expect(apply(c, { op: 'clear' }).cart.lines).toEqual([]);
    expect(refuse(cart({ lines: [] }), { op: 'clear' })).toMatch(/empty/);
  });

  it('refuses line changes on a locked cart, and lets staff unlock it', () => {
    const locked = apply(cart(), { op: 'lock' }).cart;
    expect(locked.status).toBe('locked');
    expect(refuse(locked, { op: 'add', sku: 'X', qty: 1 })).toMatch(/locked/);
    expect(refuse(locked, { op: 'promo_add', code: 'SAVE' })).toMatch(/locked/);
    expect(refuse(locked, { op: 'lock' })).toMatch(/already locked/);
    expect(apply(locked, { op: 'unlock' }).cart.status).toBe('open');
  });

  it('keeps lock, unlock and rename to staff', () => {
    const c = cart({ external });
    expect(refuse(c, { op: 'lock' }, guest)).toMatch(/staff/);
    expect(refuse(c, { op: 'rename', title: 'Mine' }, guest)).toMatch(/staff/);
    expect(apply(c, { op: 'add', sku: 'X', qty: 1 }, guest).cart.lines).toHaveLength(2);
  });

  it('renames without repricing', () => {
    const r = apply(cart(), { op: 'rename', title: '  Office chairs ' });
    expect(r.cart.title).toBe('Office chairs');
    expect(r.reprice).toBe(false);
    expect(refuse(cart(), { op: 'rename', title: ' ' })).toMatch(/title/);
  });

  it('refuses anyone who may not edit, and any change once final', () => {
    expect(refuse(cart(), { op: 'add', sku: 'X', qty: 1 }, viewer)).toMatch(/can't change/);
    expect(refuse(cart(), { op: 'add', sku: 'X', qty: 1 }, guest)).toMatch(/can't change/);
    for (const status of ['submitted', 'returned', 'canceled'] as const)
      expect(refuse(cart({ status }), { op: 'unlock' })).toBe(`The cart is ${status}.`);
  });

  it('applies and removes promo codes, normalised', () => {
    const r = apply(cart(), { op: 'promo_add', code: ' welcome15 ' });
    expect(r.cart.promoCodes).toEqual(['WELCOME15']);
    expect(r.reprice).toBe(true);
    expect(refuse(r.cart, { op: 'promo_add', code: 'WELCOME15' })).toMatch(/already/);
    expect(apply(r.cart, { op: 'promo_remove', code: 'welcome15' }).cart.promoCodes).toEqual([]);
    expect(refuse(cart(), { op: 'promo_remove', code: 'NOPE' })).toMatch(/not applied/);
    expect(refuse(cart(), { op: 'promo_add', code: 'no spaces' })).toMatch(/not a promo/);
    const full = cart({ promoCodes: Array.from({ length: MAX_PROMO_CODES }, (_, i) => `C${i}`) });
    expect(refuse(full, { op: 'promo_add', code: 'ONE-MORE' })).toMatch(/at most/);
  });
});

describe('normalizePromoCode', () => {
  it('upper-cases and trims, and refuses what cannot be a code', () => {
    expect(normalizePromoCode(' tech-20 ')).toBe('TECH-20');
    expect(normalizePromoCode('')).toBeNull();
    expect(normalizePromoCode('-LEADING')).toBeNull();
    expect(normalizePromoCode('X'.repeat(33))).toBeNull();
  });
});

describe('cart readiness', () => {
  it('needs lines and a quote for this version without errors', () => {
    expect(cartReadyProblem(cart({ lines: [] }))).toMatch(/line/);
    expect(cartReadyProblem(cart())).toBe('The cart is being priced.');
    expect(cartReadyProblem(cart({ quotedVersion: 1 }))).toBe('The cart could not be priced.');
    const priced = cart({ quote, quotedVersion: 1 });
    expect(isQuoteCurrent(priced)).toBe(true);
    expect(cartReadyProblem(priced)).toBeNull();
    expect(isQuoteCurrent(apply(priced, { op: 'add', sku: 'X', qty: 1 }).cart)).toBe(false);
    expect(
      cartReadyProblem(
        cart({
          quote,
          quotedVersion: 1,
          issues: [{ kind: 'error', code: 'unknown_sku', content: 'SKU-1 is not sold.' }],
        }),
      ),
    ).toBe('SKU-1 is not sold.');
    expect(
      cartReadyProblem(
        cart({ quote, quotedVersion: 1, issues: [{ kind: 'warning', code: 'w', content: 'w' }] }),
      ),
    ).toBeNull();
  });

  it('finishes a cart and never reopens it', () => {
    const done = finishCart(cart(), { status: 'submitted', orderId: 'ord_1' }, 70);
    expect(done).toMatchObject({
      status: 'submitted',
      orderId: 'ord_1',
      version: 2,
      updatedAt: 70,
    });
    expect(cartReadyProblem(done)).toMatch(/submitted/);
    expect(finishCart(cart(), { status: 'returned' }, 70).orderId).toBeNull();
  });

  it('expires only an open external cart past its time', () => {
    expect(isCartExpired(cart({ external }), 1_000)).toBe(true);
    expect(isCartExpired(cart({ external }), 999)).toBe(false);
    expect(isCartExpired(cart(), 10_000)).toBe(false);
    expect(isCartExpired(cart({ external, status: 'returned' }), 10_000)).toBe(false);
  });
});

describe('cart chat', () => {
  it('trims bodies and bounds their length', () => {
    expect(chatBody('  hi  ')).toBe('hi');
    expect(chatBody('   ')).toBeNull();
    expect(chatBody('x'.repeat(MAX_CHAT_BODY))).toHaveLength(MAX_CHAT_BODY);
    expect(chatBody('x'.repeat(MAX_CHAT_BODY + 1))).toBeNull();
  });

  it('lets only the author change a message', () => {
    expect(canChangeMessage({ authorId: 'usr_1' }, operator)).toBe(true);
    expect(canChangeMessage({ authorId: 'usr_1' }, viewer)).toBe(false);
  });
});
