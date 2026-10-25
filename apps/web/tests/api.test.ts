import type { Cart, Principal } from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = {
  decide: vi.fn(),
  cancel: vi.fn(),
  sendEvent: vi.fn(),
  exportDataSubject: vi.fn(),
  eraseDataSubject: vi.fn(),
  pluginCatalog: vi.fn(async () => [
    {
      id: 'example',
      runtime: 'worker',
      source: 'deployment',
      healthy: true,
      manifest: {
        id: 'example',
        name: 'Example',
        version: '1',
        nodes: [{ type: 'example.stamp' }],
        events: ['order.completed'],
      },
    },
    {
      id: 'broken',
      runtime: 'sandboxed',
      source: 'installed',
      healthy: false,
      manifest: null,
      error: 'apiVersion must be 1',
    },
  ]),
  pluginUsage: vi.fn(async () => ({ flows: [{ id: 'f1', version: 2 }], orders: [], labels: [] })),
  uploadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  approvePlugin: vi.fn(),
  createCart: vi.fn(),
  cartSnapshot: vi.fn(),
  changeCart: vi.fn(),
  submitCart: vi.fn(),
  cancelCart: vi.fn(),
};

const receipts = new Set<string>();
/** Just enough of drizzle for the webhook receipts: claim with insert, release with delete. */
const fakeDb = {
  insert: () => ({
    values: (v: { id: string }) => ({
      onConflictDoNothing: () => ({
        returning: async () => (receipts.has(v.id) ? [] : (receipts.add(v.id), [v])),
      }),
    }),
  }),
  delete: () => ({
    where: async (cond: { eq?: string }) => {
      if (cond.eq) receipts.delete(cond.eq);
    },
  }),
};
// The release deletes by id (`eq`); the prune by age (`lt`) leaves fresh receipts alone.
vi.mock('drizzle-orm', async (actual) => ({
  ...(await actual<typeof import('drizzle-orm')>()),
  eq: (_col: unknown, value: string) => ({ eq: value }),
  lt: () => ({}),
}));
const env: Record<string, unknown> = {};

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => engine, db: () => fakeDb }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({ currencies: async () => [], listOrders: async () => [] }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({
  actor: () => 'ops@example.com',
  forbidden: () => 'Forbidden',
  stepUp: async () => 'step-up needed',
}));
const listCarts = vi.fn(async (_f: unknown, _limit: number) => [] as Record<string, unknown>[]);
vi.mock('~/lib/carts.server', () => ({
  listCarts,
  isCartStatus: (v: unknown) =>
    ['open', 'locked', 'submitted', 'returned', 'canceled'].includes(v as string),
}));
const webhooks = { rotateSubscription: vi.fn() };
vi.mock('~/lib/webhooks.server', () => webhooks);

const scope = { events: ['payment.received'], startOrders: false, flows: [], channel: null };
const keys: Record<string, Record<string, unknown>> = {
  int_pay: {
    id: 'int_pay',
    name: 'Payments',
    secret: 'whsec_test',
    previousSecret: null,
    previousExpiresAt: null,
    ...scope,
  },
  int_web: {
    id: 'int_web',
    name: 'Storefront',
    secret: 'whsec_web',
    previousSecret: null,
    previousExpiresAt: null,
    ...scope,
    events: ['*'],
    channel: 'web',
  },
};
const channels: Record<string, string> = { ord_x: 'web', ord_pos: 'pos' };
const integrations = {
  findIntegration: async (id: string) => keys[id] ?? null,
  touchIntegration: async () => {},
  orderChannel: async (id: string) => channels[id] ?? null,
  createIntegration: vi.fn(),
  rotateIntegration: vi.fn(),
  revokeIntegration: vi.fn(),
  listIntegrations: vi.fn(),
};
vi.mock('~/lib/integrations.server', () => integrations);

const { handleApi, handleSignedEvent } = await import('~/lib/api.server');
const { signWebhook } = await import('@orderloop/core');

const operator: Principal = { kind: 'token', id: 'tok_1', name: 'ci', role: 'operator' };
const admin: Principal = { ...operator, id: 'tok_2', role: 'admin' };
const post = (path: string, body: unknown, as = operator) =>
  handleApi(
    new Request(`https://app.test/api/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    as,
  );

describe('starting orders over REST', () => {
  it('refuses an Idempotency-Key in a namespace the core starts orders under', async () => {
    for (const key of [
      'cart:cart_1',
      'ucp:chk_1',
      'plugin:punchout:po-1',
      'email:<m@x>',
      'a2a:1',
    ]) {
      const res = await handleApi(
        new Request('https://app.test/api/v1/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ flowId: 'tpl-b2b-order', input: { model: 'b2b' } }),
        }),
        operator,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /^Idempotency-Key may not start with cart:, ucp:/,
      );
    }
  });
});

describe('order actions over REST', () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
  });

  it('answers 404 for an unknown order and 409 for a step that is not waiting', async () => {
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'approved' })).status).toBe(404);
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_waiting' });
    const busy = await post('orders/ord_x/approvals/mgr', { decision: 'approved' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'mgr is not waiting for an approval' });
    engine.decide.mockResolvedValueOnce({ ok: true });
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'approved' })).status).toBe(200);
  });

  it('answers 409 when cancelling an order that already finished', async () => {
    engine.cancel.mockResolvedValueOnce({ ok: false, reason: 'finished' });
    const res = await post('orders/ord_x/cancel', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The order has already finished' });
    engine.cancel.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await post('orders/ord_x/cancel', {})).status).toBe(404);
    engine.cancel.mockResolvedValueOnce({ ok: true });
    expect((await post('orders/ord_x/cancel', {})).status).toBe(200);
  });

  it('passes the caller as the decider, and answers 403 when they started the order', async () => {
    engine.decide.mockResolvedValueOnce({
      ok: false,
      reason: 'own_order',
      error: 'You started this order, so someone else must decide its approvals.',
    });
    const res = await post('orders/ord_1/approvals/mgr', { decision: 'approved' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You started this order, so someone else must decide its approvals.',
    });
    expect(engine.decide).toHaveBeenCalledWith(
      'ord_1',
      'mgr',
      'approved',
      'ops@example.com',
      'tok_1',
      undefined,
    );
  });

  it('answers 404 for an event to an unknown order', async () => {
    engine.sendEvent.mockResolvedValueOnce({ delivered: false, notFound: true });
    expect((await post('orders/ord_x/events', { event: 'payment.received' })).status).toBe(404);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    const early = await post('orders/ord_x/events', { event: 'payment.received' });
    expect(early.status).toBe(200);
    expect(await early.json()).toEqual({ delivered: false });
  });
});

describe('carts over REST', () => {
  const viewer: Principal = { ...operator, id: 'tok_3', role: 'viewer' };
  const get = (path: string, as = operator) =>
    handleApi(new Request(`https://app.test/api/v1/${path}`), as);
  const cart = (patch: Partial<Cart> = {}): Cart => ({
    id: 'cart_1',
    title: 'Q4 restock',
    status: 'open',
    customerId: 'cus_northwind',
    flowId: 'tpl-b2b-order',
    external: null,
    lines: [{ id: 'l1', sku: 'WID-100', qty: 2 }],
    promoCodes: [],
    quote: null,
    quotedVersion: 2,
    issues: [],
    orderId: null,
    createdBy: 'tok_1',
    createdAt: 1,
    updatedAt: 2,
    version: 2,
    ...patch,
  });
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
    audit.mockReset();
  });

  it('lets a viewer list and read, without the chat or an external cart', async () => {
    listCarts.mockResolvedValueOnce([
      { ...cart(), pluginId: null, sessionRef: null, buyerId: null, lines: undefined },
    ]);
    const listed = await get('carts?status=open&limit=5', viewer);
    expect(listed.status).toBe(200);
    expect(listCarts).toHaveBeenLastCalledWith({ status: 'open' }, 5);
    const [row] = ((await listed.json()) as { carts: Record<string, unknown>[] }).carts;
    expect(row).toMatchObject({ id: 'cart_1', status: 'open' });
    expect(row).not.toHaveProperty('buyerId');
    expect((await get('carts?status=lost', viewer)).status).toBe(400);

    engine.cartSnapshot.mockResolvedValueOnce({
      cart: cart(),
      members: [],
      chat: [{ body: 'hi' }],
    });
    const read = await get('carts/cart_1', viewer);
    const body = (await read.json()) as { cart: Record<string, unknown> };
    expect(body.cart).toMatchObject({
      id: 'cart_1',
      quoteCurrent: false,
      notReady: 'The cart could not be priced.',
    });
    expect(JSON.stringify(body)).not.toContain('hi');
    engine.cartSnapshot.mockResolvedValueOnce({ cart: cart({ external: {} as Cart['external'] }) });
    expect((await get('carts/cart_1', viewer)).status).toBe(404);
    engine.cartSnapshot.mockResolvedValueOnce(null);
    expect((await get('carts/cart_x', viewer)).status).toBe(404);
  });

  it('refuses a viewer every change before it reaches the engine', async () => {
    for (const [path, b] of [
      ['carts', { title: 'x', flowId: 'tpl-b2b-order' }],
      ['carts/cart_1/ops', { op: 'clear' }],
      ['carts/cart_1/submit', {}],
      ['carts/cart_1/cancel', {}],
    ] as const)
      expect((await post(path, b, viewer)).status, path).toBe(403);
    expect(engine.createCart).not.toHaveBeenCalled();
    expect(engine.changeCart).not.toHaveBeenCalled();
    expect(engine.submitCart).not.toHaveBeenCalled();
  });

  it('opens a cart as the caller, whatever the body says, and audits it', async () => {
    expect((await post('carts', { flowId: 'tpl-b2b-order' })).status).toBe(400);
    engine.createCart.mockResolvedValueOnce({ ok: false, error: 'No such customer.' });
    const refused = await post('carts', {
      title: 'x',
      flowId: 'tpl-b2b-order',
      customerId: 'cus_x',
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'No such customer.' });

    engine.createCart.mockResolvedValueOnce({ ok: true, id: 'cart_1' });
    engine.cartSnapshot.mockResolvedValueOnce({ cart: cart() });
    const made = await post('carts', {
      title: ' Q4 ',
      flowId: 'tpl-b2b-order',
      createdBy: 'usr_ceo',
    });
    expect(made.status).toBe(201);
    expect(engine.createCart).toHaveBeenLastCalledWith({
      title: 'Q4',
      flowId: 'tpl-b2b-order',
      createdBy: 'tok_1',
    });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'cart.created', {
      actor: operator,
      target: 'cart_1',
      detail: { flowId: 'tpl-b2b-order', via: 'api' },
    });
  });

  it('applies a validated op as the caller, and shapes refusals', async () => {
    expect((await post('carts/cart_1/ops', { op: 'add', sku: 'WID-100', qty: 0 })).status).toBe(
      400,
    );
    expect((await post('carts/cart_1/ops', { op: 'explode' })).status).toBe(400);
    expect(engine.changeCart).not.toHaveBeenCalled();

    engine.changeCart.mockResolvedValueOnce({ ok: true, cart: { id: 'cart_1' } });
    const ok = await post('carts/cart_1/ops', { op: 'add', sku: ' WID-100 ', qty: 3 });
    expect(ok.status).toBe(200);
    expect(engine.changeCart).toHaveBeenLastCalledWith(
      'cart_1',
      { op: 'add', sku: 'WID-100', qty: 3 },
      { kind: 'staff', id: 'tok_1', name: 'ci', role: 'operator' },
    );
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'cart.changed', {
      actor: operator,
      target: 'cart_1',
      detail: { op: 'add', via: 'api' },
    });
    audit.mockClear();
    engine.changeCart.mockResolvedValueOnce({ ok: false, error: 'The cart is locked.' });
    const locked = await post('carts/cart_1/ops', { op: 'clear' });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: 'The cart is locked.' });
    engine.changeCart.mockResolvedValueOnce({ ok: false, error: 'No such cart.', notFound: true });
    expect((await post('carts/cart_x/ops', { op: 'clear' })).status).toBe(404);
    // Only a change that went in is recorded.
    expect(audit).not.toHaveBeenCalled();
  });

  it('holds a submit to the version the caller read, by ETag or body', async () => {
    engine.cartSnapshot.mockResolvedValueOnce({ cart: cart({ version: 7 }) });
    const read = await get('carts/cart_1');
    expect(read.headers.get('etag')).toBe('"7"');
    const submit = (headers: Record<string, string>, b: unknown = {}) =>
      handleApi(
        new Request('https://app.test/api/v1/carts/cart_1/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(b),
        }),
        operator,
      );
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_1' });
    expect((await submit({ 'if-match': '"7"' })).status).toBe(201);
    expect(engine.submitCart).toHaveBeenLastCalledWith('cart_1', expect.anything(), 7);
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_2' });
    await submit({}, { version: 8 });
    expect(engine.submitCart).toHaveBeenLastCalledWith('cart_1', expect.anything(), 8);
    // Optional: without either, the engine isn't asked to hold it.
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_3' });
    await submit({});
    expect(engine.submitCart).toHaveBeenLastCalledWith('cart_1', expect.anything(), undefined);

    engine.submitCart.mockResolvedValueOnce({
      ok: false,
      error: 'The cart changed since you confirmed; preview it again.',
    });
    const moved = await submit({ 'if-match': 'W/"7"' });
    expect(moved.status).toBe(412);
    expect(await moved.json()).toEqual({
      error: 'The cart has changed since version 7; read it again',
    });
    engine.submitCart.mockClear();
    expect((await submit({ 'if-match': '"seven"' })).status).toBe(400);
    expect((await submit({ 'if-match': '"7"' }, { version: 8 })).status).toBe(400);
    expect((await submit({}, { version: 0 })).status).toBe(400);
    expect(engine.submitCart).not.toHaveBeenCalled();
  });

  it('submits once, recording the order it started, and cancels', async () => {
    engine.submitCart.mockResolvedValueOnce({ ok: false, error: 'Add at least one line.' });
    expect((await post('carts/cart_1/submit', {})).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_9' });
    const done = await post('carts/cart_1/submit', {});
    expect(done.status).toBe(201);
    expect(await done.json()).toEqual({ orderId: 'ord_9', cartId: 'cart_1' });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'order.started', {
      actor: operator,
      target: 'ord_9',
      detail: { cartId: 'cart_1', via: 'api' },
    });

    engine.cancelCart.mockResolvedValueOnce({ ok: false, error: 'The cart is submitted.' });
    expect((await post('carts/cart_1/cancel', {})).status).toBe(409);
    engine.cancelCart.mockResolvedValueOnce({
      ok: true,
      cart: { id: 'cart_2', status: 'canceled' },
    });
    expect((await post('carts/cart_2/cancel', {})).status).toBe(200);
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'cart.canceled', {
      actor: operator,
      target: 'cart_2',
      detail: { via: 'api' },
    });
  });
});

describe('request validation', () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
  });

  it('refuses malformed and oversized bodies before reaching the engine', async () => {
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'maybe' })).status).toBe(400);
    expect((await post('orders/ord_x/events', { event: 42 })).status).toBe(400);
    expect(
      (await post('orders/ord_x/events', { event: 'x', payload: { blob: 'a'.repeat(40_000) } }))
        .status,
    ).toBe(400);
    expect((await post('orders/ord_x/cancel', { reason: 'r'.repeat(501) })).status).toBe(400);
    const huge = await post('orders/ord_x/cancel', { reason: 'r'.repeat(2 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(engine.decide).not.toHaveBeenCalled();
    expect(engine.sendEvent).not.toHaveBeenCalled();
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it('answers an engine failure without its internals', async () => {
    engine.cancel.mockRejectedValueOnce(new Error('D1_ERROR: no such table: orders'));
    const res = await post('orders/ord_x/cancel', {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
  });
});

describe('signed events', () => {
  const send = async (raw: string, signature: string) =>
    handleSignedEvent(
      new Request('https://app.test/api/v1/webhooks/events', {
        method: 'POST',
        headers: { 'x-orderloop-signature': signature },
        body: raw,
      }),
    );

  beforeEach(() => {
    receipts.clear();
    engine.sendEvent.mockReset();
  });

  const sign = (raw: string, keyId = 'int_pay', secret = 'whsec_test') =>
    signWebhook(secret, raw, undefined, keyId);

  it('delivers a signed event once, and lets a sender retry one nothing was waiting for', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    const signature = await sign(raw);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    expect((await send(raw, signature)).status).toBe(409);
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    expect((await send(raw, signature)).status).toBe(200);
    const replay = await send(raw, signature);
    expect(await replay.json()).toEqual({ delivered: true, duplicate: true });
    expect(engine.sendEvent).toHaveBeenCalledTimes(2);
  });

  it('refuses a key that names no integration, an unknown one, or the wrong secret', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    expect((await send(raw, await signWebhook('whsec_test', raw))).status).toBe(401);
    expect((await send(raw, await sign(raw, 'int_nope'))).status).toBe(401);
    expect((await send(raw, await sign(raw, 'int_pay', 'whsec_other'))).status).toBe(401);
    expect(engine.sendEvent).not.toHaveBeenCalled();
  });

  it("keeps an integration to its events and its channel's orders", async () => {
    const ship = JSON.stringify({ orderId: 'ord_x', event: 'shipment.delivered' });
    const refused = await send(ship, await sign(ship));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'This integration may not deliver shipment.delivered',
    });

    const pos = JSON.stringify({ orderId: 'ord_pos', event: 'payment.received' });
    expect((await send(pos, await sign(pos, 'int_web', 'whsec_web'))).status).toBe(403);
    const missing = JSON.stringify({ orderId: 'ord_missing', event: 'payment.received' });
    expect((await send(missing, await sign(missing, 'int_web', 'whsec_web'))).status).toBe(404);

    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    const web = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    expect((await send(web, await sign(web, 'int_web', 'whsec_web'))).status).toBe(200);
    expect(engine.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("spends only a verified integration's budget, and answers 429 once it runs out", async () => {
    const spent: string[] = [];
    env.WEBHOOK_LIMIT = {
      limit: async ({ key }: { key: string }) => {
        spent.push(key);
        return { success: spent.length < 2 };
      },
    };
    try {
      const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
      // A forged signature is refused before it can use up the real sender's budget.
      expect((await send(raw, await sign(raw, 'int_pay', 'whsec_other'))).status).toBe(401);
      expect(spent).toEqual([]);
      engine.sendEvent.mockResolvedValue({ delivered: true, nodeId: 'pay' });
      expect((await send(raw, await sign(raw))).status).toBe(200);
      const limited = await send(raw, await sign(raw));
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(spent).toEqual(['int_pay', 'int_pay']);
      expect(engine.sendEvent).toHaveBeenCalledTimes(1);
    } finally {
      delete env.WEBHOOK_LIMIT;
    }
  });
});

describe('integrations over REST', () => {
  beforeEach(() => audit.mockReset());

  it('creates a key, shows its secret once, and records who did', async () => {
    integrations.createIntegration.mockResolvedValueOnce({
      integration: { id: 'int_new', name: 'Stripe' },
      secret: 'whsec_abc',
    });
    const res = await post('integrations', { name: 'Stripe', events: ['payment.received'] }, admin);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ secret: 'whsec_abc' });
    expect(integrations.createIntegration).toHaveBeenCalledWith(
      { name: 'Stripe', events: ['payment.received'], startOrders: false, flows: [] },
      'ops@example.com',
    );
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'integration.created', {
      actor: admin,
      target: 'Stripe',
      detail: { id: 'int_new' },
    });
  });

  it('rotates and revokes, 404 for an unknown key, and needs an admin', async () => {
    integrations.rotateIntegration.mockResolvedValueOnce({
      integration: { name: 'Stripe' },
      secret: 'whsec_2',
    });
    expect((await post('integrations/int_new/rotate', {}, admin)).status).toBe(200);
    integrations.rotateIntegration.mockResolvedValueOnce(null);
    expect((await post('integrations/int_nope/rotate', {}, admin)).status).toBe(404);
    integrations.revokeIntegration.mockResolvedValueOnce({ name: 'Stripe' });
    const del = await handleApi(
      new Request('https://app.test/api/v1/integrations/int_new', { method: 'DELETE' }),
      admin,
    );
    expect(del.status).toBe(200);
    expect(audit.mock.calls.map((c) => c[1])).toEqual([
      'integration.rotated',
      'integration.revoked',
    ]);
    // Operators run orders and flows; keys, webhooks and the audit log are an admin's.
    for (const path of [
      'integrations',
      'webhook-subscriptions',
      'audit-events',
      'audit-events/verify',
    ])
      expect(
        (await handleApi(new Request(`https://app.test/api/v1/${path}`), operator)).status,
      ).toBe(403);
  });
});

describe('webhook subscriptions over REST', () => {
  beforeEach(() => audit.mockReset());

  it('rotates a signing secret, shows it once and records who did; 404 for an unknown one', async () => {
    webhooks.rotateSubscription.mockResolvedValueOnce({
      subscription: { id: 'whs_1', url: 'https://hooks.example/a' },
      secret: 'whsec_next',
    });
    const res = await post('webhook-subscriptions/whs_1/rotate', {}, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ secret: 'whsec_next' });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'webhook.rotated', {
      actor: admin,
      target: 'https://hooks.example/a',
      detail: { id: 'whs_1', via: 'api' },
    });
    webhooks.rotateSubscription.mockResolvedValueOnce(null);
    expect((await post('webhook-subscriptions/whs_nope/rotate', {}, admin)).status).toBe(404);
    expect((await post('webhook-subscriptions/whs_1/rotate', {}, operator)).status).toBe(403);
  });
});

describe('order list paging', () => {
  it('round-trips a cursor and refuses one it did not issue', async () => {
    const { decodeCursor, encodeCursor } = await import('~/lib/cursor');
    const c = { createdAt: 1_790_000_000_000, id: 'ord_abc:1' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-base64!')).toBeNull();
    expect(decodeCursor(btoa('later:ord_1'))).toBeNull();
    const res = await handleApi(
      new Request('https://app.test/api/v1/orders?cursor=bogus'),
      operator,
    );
    expect(res.status).toBe(400);
  });
});

describe('data subject requests over REST', () => {
  beforeEach(() => audit.mockReset());

  it("are an admin's, and the audit log names the person only by a hash", async () => {
    expect((await post('data-subjects/erase', { email: 'jane@example.com' })).status).toBe(403);
    expect((await post('data-subjects/erase', { email: 'not an email' }, admin)).status).toBe(400);

    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: true,
      done: true,
      orders: 2,
      customers: 1,
      documents: 3,
      messages: 1,
      inboundEmails: 0,
      teamMember: false,
    });
    const res = await post('data-subjects/erase', { email: 'Jane@Example.com' }, admin);
    expect(res.status).toBe(200);
    expect(engine.eraseDataSubject).toHaveBeenCalledWith('Jane@Example.com');
    const [, action, event] = audit.mock.calls[0]!;
    expect(action).toBe('personal_data.erased');
    expect(event.target).toMatch(/^subject:[0-9a-f]{16}$/);
    expect(JSON.stringify(event)).not.toMatch(/jane/i);

    // The same person hashes the same, whatever the case.
    engine.exportDataSubject.mockResolvedValueOnce({ orders: [], customers: [] });
    const exported = await post('data-subjects/export', { email: ' jane@example.com' }, admin);
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    expect(audit.mock.calls[1]![2].target).toBe(event.target);
  });

  it('answers 409 while their orders still run', async () => {
    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: false,
      reason: 'active_orders',
      orders: ['ord_1'],
    });
    const res = await post('data-subjects/erase', { email: 'jane@example.com' }, admin);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ orders: ['ord_1'] });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('plugins over REST', () => {
  const get = (path: string, as = admin) =>
    handleApi(new Request(`https://app.test/api/v1/${path}`), as);

  it('lists the installed plugins and what uses one, for an admin', async () => {
    expect((await get('plugins', operator)).status).toBe(403);
    expect(await (await get('plugins')).json()).toEqual({
      plugins: [
        {
          id: 'example',
          runtime: 'worker',
          source: 'deployment',
          name: 'Example',
          version: '1',
          nodes: ['example.stamp'],
          events: ['order.completed'],
          provides: [],
          healthy: true,
        },
        {
          id: 'broken',
          runtime: 'sandboxed',
          source: 'installed',
          name: null,
          version: null,
          nodes: [],
          events: [],
          provides: [],
          healthy: false,
          error: 'apiVersion must be 1',
        },
      ],
    });
    expect(await (await get('plugins/example/usage')).json()).toEqual({
      flows: [{ id: 'f1', version: 2 }],
      orders: [],
      labels: [],
    });
    expect(engine.pluginUsage).toHaveBeenCalledWith('example');
    expect((await get('plugins/Not_An_Id/usage')).status).toBe(404);
  });
});

describe('installing plugins over REST', () => {
  const review = { id: 'acme-carrier', sha: 'a'.repeat(64), version: '2', publisher: 'acme' };
  const upload = (text: string, as = admin) =>
    handleApi(new Request('https://app.test/api/v1/plugins', { method: 'POST', body: text }), as);

  beforeEach(() => {
    audit.mockReset();
    engine.uploadPlugin.mockReset();
    engine.setPluginEnabled.mockReset();
  });

  it('uploads a signed file for review, and audits it', async () => {
    engine.uploadPlugin.mockResolvedValueOnce({
      ok: true,
      value: { ...review, status: 'pending' },
    });
    expect((await upload('{}', operator)).status).toBe(403);
    const res = await upload('{"format":1}');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'acme-carrier', status: 'pending' });
    expect(engine.uploadPlugin).toHaveBeenCalledWith('{"format":1}', admin.id);
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.uploaded');
    expect(audit.mock.calls[0]?.[2]).toMatchObject({
      target: 'acme-carrier',
      detail: { version: '2', publisher: 'acme', sha: 'a'.repeat(12) },
    });
  });

  it('answers a refusal with its reason, audited, and never approves', async () => {
    engine.uploadPlugin.mockResolvedValueOnce({
      ok: false,
      error: '“nobody” is not a publisher this deployment trusts',
    });
    const res = await upload('{}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: '“nobody” is not a publisher this deployment trusts',
    });
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.refused');
    expect(engine.approvePlugin).not.toHaveBeenCalled();
    expect((await post('plugins/acme-carrier/approve', {}, admin)).status).toBe(404);
  });

  it('refuses a file larger than a plugin may be, before the engine sees it', async () => {
    const res = await upload('x'.repeat(5 * 1024 * 1024 + 2));
    expect(res.status).toBe(413);
    expect(engine.uploadPlugin).not.toHaveBeenCalled();
  });

  it('turns a plugin off', async () => {
    engine.setPluginEnabled.mockResolvedValueOnce({ ok: true, value: { id: 'acme-carrier' } });
    const res = await post('plugins/acme-carrier/disable', {}, admin);
    expect(await res.json()).toEqual({ id: 'acme-carrier', status: 'disabled' });
    expect(engine.setPluginEnabled).toHaveBeenCalledWith('acme-carrier', false);
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.disabled');
    expect((await post('plugins/acme-carrier/disable', {}, operator)).status).toBe(403);
    engine.setPluginEnabled.mockResolvedValueOnce({
      ok: false,
      error: 'example is not installed at runtime',
    });
    const registry = await post('plugins/example/disable', {}, admin);
    expect(registry.status).toBe(400);
    expect(await registry.json()).toEqual({ error: 'example is not installed at runtime' });
  });
});
