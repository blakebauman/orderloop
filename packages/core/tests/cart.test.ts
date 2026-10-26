import { describe, expect, it } from 'vitest';
import {
  applyCartOp,
  attachmentName,
  attachmentProblem,
  CART_EXTEND_STEP_MS,
  type Cart,
  type CartActor,
  type CartOp,
  canChangeMessage,
  canEditCart,
  canReadCart,
  canRemoveAttachment,
  cartAttachmentKey,
  cartOpSchema,
  cartReadyProblem,
  cartShippingOption,
  cartView,
  chatBody,
  type ExternalCartInput,
  extendedCartExpiry,
  externalCartCap,
  externalCartEnd,
  externalCartProblem,
  finishCart,
  isCartExpired,
  isQuoteCurrent,
  MAX_CART_ATTACHMENTS,
  MAX_CHAT_BODY,
  MAX_CHECKOUT_LINES,
  MAX_EXTERNAL_CART_MS,
  MAX_LINE_QUANTITY,
  MAX_PROMO_CODES,
  MIN_EXTERNAL_CART_IDLE_MS,
  newCart,
  normalizePromoCode,
  SHIP_TO_LIMITS,
  staffCartActor,
  storedCart,
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
  shipTo: null,
  shippingOption: null,
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

const external = {
  pluginId: 'punchout',
  sessionRef: 'cookie-1',
  expiresAt: 1_000,
  idleMs: null,
  returnUrl: 'https://buyer.example/return',
  frameOrigins: [],
  buyer: { id: 'b1', name: 'Cy' },
};
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

  it('sets several quantities as one change, removing the lines set to 0', () => {
    const c = cart({
      lines: [
        { id: 'li_1', sku: 'A', qty: 1 },
        { id: 'li_2', sku: 'B', qty: 1 },
        { id: 'li_3', sku: 'C', qty: 1 },
      ],
      quote,
      quotedVersion: 1,
    });
    const r = apply(c, {
      op: 'set_qtys',
      lines: [
        { lineId: 'li_3', qty: 5 },
        { lineId: 'li_1', qty: 0 },
      ],
    });
    // In the cart's order, whatever order they were named in.
    expect(r.cart.lines.map((l) => [l.sku, l.qty])).toEqual([
      ['B', 1],
      ['C', 5],
    ]);
    expect(r.cart.version).toBe(2);
    expect(r.reprice).toBe(true);
    expect(isQuoteCurrent(r.cart)).toBe(false);
    // The buyer of an external cart sets them too.
    expect(
      apply(cart({ external }), { op: 'set_qtys', lines: [{ lineId: 'li_1', qty: 4 }] }, guest).cart
        .lines[0]?.qty,
    ).toBe(4);
  });

  it('sets several quantities all or none', () => {
    const c = cart({
      lines: [
        { id: 'li_1', sku: 'A', qty: 1 },
        { id: 'li_2', sku: 'B', qty: 1 },
      ],
    });
    // A line someone removed meanwhile refuses the lot.
    expect(
      refuse(c, {
        op: 'set_qtys',
        lines: [
          { lineId: 'li_1', qty: 3 },
          { lineId: 'li_9', qty: 3 },
        ],
      }),
    ).toMatch(/gone/);
    expect(
      refuse(c, {
        op: 'set_qtys',
        lines: [
          { lineId: 'li_1', qty: 3 },
          { lineId: 'li_1', qty: 4 },
        ],
      }),
    ).toMatch(/once/);
    for (const qty of [-1, 1.5, MAX_LINE_QUANTITY + 1])
      expect(
        refuse(c, {
          op: 'set_qtys',
          lines: [
            { lineId: 'li_1', qty: 2 },
            { lineId: 'li_2', qty },
          ],
        }),
      ).toMatch(/quantity/);
    // The socket's ops never pass `cartOpSchema`, so the cart bounds them itself.
    expect(refuse(c, { op: 'set_qtys', lines: [] })).toMatch(/Choose/);
    expect(refuse(c, { op: 'set_qtys' } as unknown as CartOp)).toMatch(/Choose/);
    expect(
      refuse(c, {
        op: 'set_qtys',
        lines: Array.from({ length: MAX_CHECKOUT_LINES + 1 }, (_, i) => ({
          lineId: `li_${i}`,
          qty: 1,
        })),
      }),
    ).toMatch(/Choose/);
    expect(
      refuse(c, { op: 'set_qtys', lines: [null, { lineId: 'li_1', qty: 1 }] } as unknown as CartOp),
    ).toMatch(/quantity/);
    expect(
      refuse(apply(c, { op: 'lock' }).cart, {
        op: 'set_qtys',
        lines: [{ lineId: 'li_1', qty: 2 }],
      }),
    ).toMatch(/locked/);
    expect(refuse(c, { op: 'set_qtys', lines: [{ lineId: 'li_1', qty: 2 }] }, viewer)).toMatch(
      /can't change/,
    );
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

  it('keeps a current quote current across lock, unlock and rename', () => {
    const priced = cart({ quote, quotedVersion: 1 });
    const locked = apply(priced, { op: 'lock' }).cart;
    expect(isQuoteCurrent(locked)).toBe(true);
    expect(cartReadyProblem(locked)).toBeNull();
    expect(isQuoteCurrent(apply(locked, { op: 'unlock' }).cart)).toBe(true);
    expect(isQuoteCurrent(apply(priced, { op: 'rename', title: 'New' }).cart)).toBe(true);
    // A stale quote stays stale.
    expect(isQuoteCurrent(apply(cart({ quote, quotedVersion: 0 }), { op: 'lock' }).cart)).toBe(
      false,
    );
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

describe('ship-to and shipping option', () => {
  const address = {
    line1: '1 Main St',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'US',
  };
  const offering = {
    ...quote,
    ships: true,
    shippingOptions: [
      { id: 'standard', title: 'Standard', carrier: 'UPS', amount: 7, minDays: 3, maxDays: 5 },
      { id: 'express', title: 'Express', carrier: 'FedEx', amount: 22, minDays: 1, maxDays: 2 },
    ],
    shippingOption: 'standard',
  };

  it('sets a ship-to, trimmed and without unknown fields, and prices the cart again', () => {
    const r = apply(cart(), {
      op: 'set_ship_to',
      address: { ...address, line1: '  1 Main St ', line2: '  ', lat: 1 } as never,
    });
    expect(r.cart.shipTo).toEqual(address);
    expect(r.reprice).toBe(true);
    expect(r.cart.version).toBe(2);
    // The buyer of an external cart may set it too.
    expect(apply(cart({ external }), { op: 'set_ship_to', address }, guest).cart.shipTo).toEqual(
      address,
    );
  });

  it('refuses an address that is empty, too long or not text', () => {
    const bad = [
      {},
      { line1: '   ' },
      { line1: 'x'.repeat(SHIP_TO_LIMITS.line1 + 1) },
      { city: 42 },
    ];
    for (const a of bad)
      expect(refuse(cart(), { op: 'set_ship_to', address: a as never }), JSON.stringify(a)).toMatch(
        /Give an address/,
      );
  });

  it('clears the option with the address, and refuses clearing what is not there', () => {
    const set = cart({ shipTo: address, shippingOption: 'express' });
    const r = apply(set, { op: 'set_ship_to', address: null });
    expect(r.cart).toMatchObject({ shipTo: null, shippingOption: null });
    expect(r.reprice).toBe(true);
    expect(refuse(cart(), { op: 'set_ship_to', address: null })).toMatch(/no ship-to/);
    expect(refuse(cart(), { op: 'set_shipping_option', option: null })).toMatch(/No shipping/);
  });

  it('chooses an option the current quote offers, and leaves a stale quote to the next one', () => {
    const priced = cart({ quote: offering, quotedVersion: 1 });
    const r = apply(priced, { op: 'set_shipping_option', option: 'express' });
    expect(r.cart.shippingOption).toBe('express');
    expect(r.reprice).toBe(true);
    expect(refuse(priced, { op: 'set_shipping_option', option: 'teleport' })).toBe(
      'The shipping option “teleport” is not offered.',
    );
    // Not priced for this version: the reprice reports an option it doesn't offer.
    expect(
      apply(cart({ quote: offering }), { op: 'set_shipping_option', option: 'teleport' }).cart
        .shippingOption,
    ).toBe('teleport');
    expect(
      apply(cart({ shippingOption: 'express' }), { op: 'set_shipping_option', option: null }).cart
        .shippingOption,
    ).toBeNull();
  });

  it('changes only on an open cart, for whoever may edit it', () => {
    expect(refuse(cart({ status: 'locked' }), { op: 'set_ship_to', address })).toMatch(/locked/);
    expect(refuse(cart(), { op: 'set_ship_to', address }, viewer)).toMatch(/can't change/);
    expect(refuse(cart(), { op: 'set_shipping_option', option: 'standard' }, guest)).toMatch(
      /can't change/,
    );
    expect(refuse(cart({ status: 'submitted' }), { op: 'set_ship_to', address })).toMatch(
      /submitted/,
    );
  });

  it('needs a complete address to submit only when the quote ships with options on offer', () => {
    const priced = (c: Partial<Cart>) => cart({ quotedVersion: 1, ...c });
    expect(cartReadyProblem(priced({ quote: offering }))).toMatch(/complete ship-to/);
    expect(
      cartReadyProblem(priced({ quote: offering, shipTo: { line1: '1 Main St', country: 'US' } })),
    ).toMatch(/complete ship-to/);
    expect(cartReadyProblem(priced({ quote: offering, shipTo: address }))).toBeNull();
    // Nothing ships, or the flow prices no shipping: no address needed.
    expect(cartReadyProblem(priced({ quote: { ...offering, ships: false } }))).toBeNull();
    expect(
      cartReadyProblem(
        priced({ quote: { ...offering, shippingOptions: [], shippingOption: null } }),
      ),
    ).toBeNull();
    // An external cart goes back to the buyer's system, whose PO says where it ships.
    expect(cartReadyProblem(priced({ quote: offering, external }))).toBeNull();
  });

  it('refuses an option while a current quote offers none', () => {
    expect(
      refuse(cart({ quote, quotedVersion: 1 }), { op: 'set_shipping_option', option: 'standard' }),
    ).toBe('This cart’s flow offers no shipping options.');
  });

  it('ships by what a current quote charged, and by the chosen option until then', () => {
    // A flow that picks the cheapest charged Standard though Express was chosen.
    const chosen = { shippingOption: 'express', quote: offering };
    expect(cartShippingOption(cart({ ...chosen, quotedVersion: 1 }))).toBe('standard');
    expect(cartShippingOption(cart(chosen))).toBe('express');
    expect(cartShippingOption(cart())).toBeNull();
  });

  it('reads a cart stored before ship-to as shipping nowhere, and starts one that way', () => {
    const { shipTo: _s, shippingOption: _o, ...old } = cart();
    expect(storedCart(old as Cart)).toMatchObject({ shipTo: null, shippingOption: null });
    const kept = cart({ shipTo: address, shippingOption: 'express' });
    expect(storedCart(kept)).toEqual(kept);
    expect(
      newCart({
        id: 'cart_2',
        title: 'New',
        flowId: 'flow_1',
        customerId: null,
        external: null,
        lines: [],
        createdBy: 'usr_1',
        now: 5,
      }),
    ).toMatchObject({
      status: 'open',
      shipTo: null,
      shippingOption: null,
      version: 1,
      quotedVersion: 0,
    });
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
    expect(
      isQuoteCurrent(finishCart(cart({ quote, quotedVersion: 1 }), { status: 'canceled' }, 70)),
    ).toBe(true);
  });

  it('expires only an open external cart past its time', () => {
    expect(isCartExpired(cart({ external }), 1_000)).toBe(true);
    expect(isCartExpired(cart({ external }), 999)).toBe(false);
    expect(isCartExpired(cart(), 10_000)).toBe(false);
    expect(isCartExpired(cart({ external, status: 'returned' }), 10_000)).toBe(false);
  });
});

describe('an external cart that stays open while its buyer works', () => {
  const H = 3_600_000;
  const MIN = 60_000;
  // Opened at 1h for two hours, and two hours from the buyer's last activity.
  const open = (o: Partial<Cart['external'] & object> = {}, c: Partial<Cart> = {}) =>
    cart({ createdAt: H, external: { ...external, expiresAt: 3 * H, idleMs: 2 * H, ...o }, ...c });

  it('moves its time to the idle window from now', () => {
    expect(extendedCartExpiry(open(), 2 * H)).toBe(4 * H);
    expect(externalCartCap(open())).toBe(H + MAX_EXTERNAL_CART_MS);
  });

  it('moves it at most once a minute, but always the last step to its cap', () => {
    expect(extendedCartExpiry(open(), H + CART_EXTEND_STEP_MS - 1)).toBeNull();
    expect(extendedCartExpiry(open(), H + CART_EXTEND_STEP_MS)).toBe(3 * H + MIN);
    const cap = externalCartCap(open());
    // Half a minute on is too little, unless it's the last half minute before the cap.
    expect(
      extendedCartExpiry(open({ expiresAt: cap - 5 * MIN }), cap - 2 * H - 4.5 * MIN),
    ).toBeNull();
    expect(extendedCartExpiry(open({ expiresAt: cap - 30_000 }), cap - 2 * H + 10_000)).toBe(cap);
    expect(extendedCartExpiry(open({ expiresAt: cap }), cap - MIN)).toBeNull();
  });

  it('never moves it past 24 hours from when it opened', () => {
    expect(extendedCartExpiry(open({ idleMs: MAX_EXTERNAL_CART_MS }), 2 * H)).toBe(
      H + MAX_EXTERNAL_CART_MS,
    );
    // Kept open to 24h, the buyer active half an hour before: two more hours would pass the cap.
    expect(extendedCartExpiry(open({ expiresAt: 24 * H }), 23.5 * H)).toBe(
      H + MAX_EXTERNAL_CART_MS,
    );
  });

  it('leaves a fixed time, a staff cart, an ended or a closed cart as they are', () => {
    expect(extendedCartExpiry(open({ idleMs: null }), 2 * H)).toBeNull();
    // A cart stored before idle windows has none at all.
    const { idleMs: _, ...old } = open().external!;
    expect(extendedCartExpiry(cart({ external: old as never }), 2 * H)).toBeNull();
    expect(storedCart(cart({ external: old as never })).external?.idleMs).toBeNull();
    expect(extendedCartExpiry(cart(), 2 * H)).toBeNull();
    expect(extendedCartExpiry(open({}, { status: 'returned' }), 2 * H)).toBeNull();
    expect(extendedCartExpiry(open({}, { status: 'canceled' }), 2 * H)).toBeNull();
    // Activity after its time doesn't bring it back.
    expect(extendedCartExpiry(open(), 3 * H)).toBeNull();
    // A locked cart is still open: its buyer is waiting on staff, not gone.
    expect(extendedCartExpiry(open({}, { status: 'locked' }), 2 * H)).toBe(4 * H);
  });

  it('lets its buyer in for as long as it could stay open', () => {
    expect(externalCartEnd(open())).toBe(H + MAX_EXTERNAL_CART_MS);
    expect(externalCartEnd(open({ idleMs: null }))).toBe(3 * H);
    expect(externalCartEnd(cart())).toBeNull();
  });
});

describe('what a plugin may open an external cart with', () => {
  const now = 1_000_000;
  const input = (o: Partial<ExternalCartInput> = {}): ExternalCartInput => ({
    sessionRef: 's1',
    title: 'Punchout',
    flowId: 'flow_1',
    buyer: { id: 'b1', name: 'Cy' },
    returnUrl: 'https://buyer.example/return',
    expiresAt: now + 3_600_000,
    ...o,
  });

  it('takes an idle window from 5 minutes to 24 hours, or none', () => {
    expect(externalCartProblem(input(), now)).toBeNull();
    expect(externalCartProblem(input({ idleMs: MIN_EXTERNAL_CART_IDLE_MS }), now)).toBeNull();
    expect(externalCartProblem(input({ idleMs: MAX_EXTERNAL_CART_MS }), now)).toBeNull();
    for (const idleMs of [
      MIN_EXTERNAL_CART_IDLE_MS - 1,
      MAX_EXTERNAL_CART_MS + 1,
      0,
      -60_000,
      600_000.5,
      Number.NaN,
      '600000' as never,
    ])
      expect(externalCartProblem(input({ idleMs }), now)).toMatch(/idleMs/);
  });

  it('still opens it for 24 hours at most', () => {
    expect(
      externalCartProblem(
        input({ expiresAt: now + MAX_EXTERNAL_CART_MS + 1, idleMs: 600_000 }),
        now,
      ),
    ).toMatch(/24 hours/);
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

describe('cart files', () => {
  it('keeps a file name to its base name, without control characters or quotes', () => {
    expect(attachmentName('C:\\specs\\widget "a".pdf')).toBe('widget a.pdf');
    expect(attachmentName('../../etc/passwd')).toBe('passwd');
    expect(attachmentName('bad\nname.txt')).toBe('badname.txt');
    expect(attachmentName('')).toBe('file');
    expect(attachmentName(`${'x'.repeat(200)}.pdf`)).toHaveLength(120);
  });

  it('takes documents and images up to 10 MB, and a cart holds 20', () => {
    expect(attachmentProblem({ type: 'application/pdf', size: 1 }, 0)).toBeNull();
    expect(attachmentProblem({ type: 'text/html', size: 1 }, 0)).toMatch(/Attach a PDF/);
    expect(attachmentProblem({ type: 'image/svg+xml', size: 1 }, 0)).toMatch(/Attach a PDF/);
    expect(attachmentProblem({ type: 'application/pdf', size: 0 }, 0)).toMatch(/empty/);
    expect(attachmentProblem({ type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }, 0)).toMatch(
      /10 MB/,
    );
    expect(attachmentProblem({ type: 'application/pdf', size: 1 }, MAX_CART_ATTACHMENTS)).toMatch(
      /at most 20/,
    );
  });

  it('lets whoever added a file, or an operator, remove it', () => {
    const a = { by: { id: 'guest:b1', name: 'Pat' } };
    expect(canRemoveAttachment(a, guest)).toBe(false);
    expect(canRemoveAttachment(a, { kind: 'guest', id: 'guest:b1', name: 'Pat' })).toBe(true);
    expect(canRemoveAttachment(a, operator)).toBe(true);
    expect(canRemoveAttachment(a, viewer)).toBe(false);
  });

  it('files a cart’s files under the cart', () => {
    expect(cartAttachmentKey('cart_1', 'att_1')).toBe('carts/cart_1/att_1');
  });
});

describe('carts outside their page', () => {
  it('takes only well-formed ops, within the bounds the cart applies', () => {
    expect(cartOpSchema.parse({ op: 'add', sku: ' SKU-1 ', qty: 3 })).toEqual({
      op: 'add',
      sku: 'SKU-1',
      qty: 3,
    });
    for (const bad of [
      { op: 'add', sku: 'SKU-1', qty: 0 },
      { op: 'add', sku: 'SKU-1', qty: MAX_LINE_QUANTITY + 1 },
      { op: 'set_qty', lineId: 'li_1', qty: 1.5 },
      { op: 'remove', lineIds: [] },
      { op: 'set_qtys', lines: [] },
      { op: 'set_qtys', lines: [{ lineId: 'li_1', qty: -1 }] },
      { op: 'set_qtys', lines: [{ lineId: '', qty: 1 }] },
      {
        op: 'set_qtys',
        lines: Array.from({ length: MAX_CHECKOUT_LINES + 1 }, (_, i) => ({
          lineId: `li_${i}`,
          qty: 1,
        })),
      },
      { op: 'rename', title: '' },
      { op: 'set_ship_to' },
      { op: 'set_ship_to', address: { line1: 'x'.repeat(201) } },
      { op: 'set_ship_to', address: { city: 7 } },
      { op: 'set_shipping_option', option: '' },
      { op: 'set_shipping_option', option: 'x'.repeat(81) },
      { op: 'explode' },
      { sku: 'SKU-1', qty: 1 },
    ])
      expect(cartOpSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(
      cartOpSchema.parse({ op: 'set_ship_to', address: { line1: ' 1 Main St ', geo: 'x' } }),
    ).toEqual({ op: 'set_ship_to', address: { line1: '1 Main St' } });
    expect(cartOpSchema.parse({ op: 'set_ship_to', address: null })).toEqual({
      op: 'set_ship_to',
      address: null,
    });
    expect(cartOpSchema.parse({ op: 'set_shipping_option', option: null }).op).toBe(
      'set_shipping_option',
    );
    // Unknown keys are dropped, so a body can't smuggle a price onto a line.
    expect(
      cartOpSchema.parse({ op: 'add', sku: 'SKU-1', qty: 1, unitPrice: 0 }),
    ).not.toHaveProperty('unitPrice');
  });

  it('acts as staff, never a guest, and shows a cart without its external details', () => {
    expect(staffCartActor({ id: 'tok_1', name: 'ci', role: 'viewer' })).toEqual({
      kind: 'staff',
      id: 'tok_1',
      name: 'ci',
      role: 'viewer',
    });
    const v = cartView(cart({ external, quote, quotedVersion: 1 }));
    expect(v).not.toHaveProperty('external');
    expect(v).not.toHaveProperty('quotedVersion');
    expect(v).toMatchObject({ quoteCurrent: true, notReady: null });
    expect(cartView(cart({ lines: [] }))).toMatchObject({
      quoteCurrent: false,
      notReady: 'Add at least one line.',
    });
  });
});
