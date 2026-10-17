import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  CHECKOUT_CAPABILITY,
  digestMatches,
  FULFILLMENT_CAPABILITY,
  importVerifyKey,
  ORDER_CAPABILITY,
  type OrderState,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  signPlatform,
  UCP_VERSION,
  verifyMessage,
} from '@orderloop/core';
import { checkoutSessions, orders } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { eraseDataSubject, exportDataSubject } from '../src/subjects';
import { ucpProfile } from '../src/ucp/config';
import { signed } from './principal';
import {
  db,
  enableUcp,
  key,
  monitorCheckout,
  ORIGIN,
  pay,
  platform,
  platformProfile,
  principalKey,
  ucp,
  until,
} from './ucp-helpers';

// Order webhooks to the platform are caught here; everything else goes out as usual.
const hooks: { url: string; headers: Headers; body: string }[] = [];
const realFetch = globalThis.fetch;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

let alpha: PlatformCaller;
beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
  alpha = await platform('alpha');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url.startsWith('https://platform.example/')) {
      // Read here: the request belongs to the OrderAgent that sent it.
      hooks.push({ url: req.url, headers: new Headers(req.headers), body: await req.text() });
      return new Response(null, { status: 204 });
    }
    return realFetch(input as RequestInfo, init);
  });
});
afterAll(() => vi.restoreAllMocks());
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('UCP discovery', () => {
  it('publishes the profile with the signing key and the test payment handler', async () => {
    const profile = (await ucpProfile(env, ORIGIN))!;
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(profile.keys).toEqual([
      expect.objectContaining({ kid: 'test-ucp-2026', kty: 'EC', crv: 'P-256', alg: 'ES256' }),
    ]);
    expect(profile.keys[0]).not.toHaveProperty('d');
    expect(Object.keys(profile.ucp.payment_handlers)).toEqual(['app.orderloop.test']);
  });
});

describe('UCP checkout', () => {
  it('refuses a request without the signed platform header, and a principal header', async () => {
    expect((await ucp(null, 'GET', '/ucp/v1/checkout-sessions/x')).status).toBe(401);
    const person = await signed(
      { kind: 'user', id: 'usr_x', name: 'x', role: 'admin' },
      '/ucp/v1/checkout-sessions/x',
    );
    expect(
      (
        await ucp(null, 'GET', '/ucp/v1/checkout-sessions/x', undefined, {
          [PRINCIPAL_HEADER]: person,
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a platform's header at the workspace's own MCP and A2A endpoints", async () => {
    for (const path of ['/mcp', '/a2a']) {
      const res = await worker.fetch(
        new Request(`https://engine${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            [PRINCIPAL_HEADER]: await signPlatform(principalKey, alpha, path),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        env,
      );
      expect(res.status).toBe(401);
    }
  });

  it('prices a checkout with the storefront flow and makes it ready', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    expect(r.status).toBe(201);
    const c = r.body;
    expect(c.status).toBe('ready_for_complete');
    expect(c.ucp.capabilities).toEqual({
      [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }],
      [FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION }],
    });
    expect(c.line_items[0].item).toEqual({ id: 'MON-27', title: '27" monitor', price: 34900 });
    const types = c.totals.map((t: { type: string }) => t.type);
    expect(types).toEqual(['subtotal', 'fulfillment', 'tax', 'total']);
    const total = c.totals.at(-1).amount;
    expect(total).toBe(
      c.totals.slice(0, -1).reduce((n: number, t: { amount: number }) => n + t.amount, 0),
    );
    const method = c.fulfillment.methods[0];
    expect(method.destinations[0]).toMatchObject({ id: 'dest_1', postal_code: '78701' });
    expect(method.groups[0].options.length).toBeGreaterThan(0);
    expect(method.groups[0].selected_option_id).toBeTruthy();
    expect(c.links).toEqual([{ type: 'terms_of_service', url: 'https://shop.example/terms' }]);
  });

  it('asks for what is missing, and reports the store policy', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', {
      line_items: [{ item: { id: 'MON-27' }, quantity: 11 }],
    });
    expect(r.body.status).toBe('incomplete');
    const codes = r.body.messages.map((m: { code: string }) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['missing', 'policy']));
    expect(r.body.messages.find((m: { path?: string }) => m.path === '$.buyer.email')).toBeTruthy();
  });

  it('answers an error response when nothing in it is sold', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', {
      line_items: [{ item: { id: 'NOPE-1' }, quantity: 1 }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ucp: { status: 'error' },
      messages: [{ code: 'item_unavailable', severity: 'unrecoverable' }],
    });
    expect(r.body).not.toHaveProperty('id');
  });

  it("keeps one platform's checkouts from another", async () => {
    const created = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const beta = await platform('beta');
    const r = await ucp(beta, 'GET', `/ucp/v1/checkout-sessions/${created.body.id}`);
    expect(r.body).toMatchObject({ ucp: { status: 'error' }, messages: [{ code: 'not_found' }] });
  });

  it('updates by full replacement, keeping the ship-to named by id', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const r = await ucp(alpha, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      line_items: [{ id: c.line_items[0].id, item: { id: 'MON-27' }, quantity: 2 }],
      buyer: monitorCheckout.buyer,
      fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.line_items[0]).toMatchObject({ id: c.line_items[0].id, quantity: 2 });
    expect(r.body.fulfillment.methods[0].destinations[0].street_address).toBe('500 Congress Ave');
    expect(r.body.status).toBe('ready_for_complete');
  });

  it('needs an Idempotency-Key to complete, replays it, and refuses it for another body', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const path = `/ucp/v1/checkout-sessions/${c.id}/complete`;
    expect((await ucp(alpha, 'POST', path, pay('tok_test_decline'))).status).toBe(400);
    const k = key();
    const first = await ucp(alpha, 'POST', path, pay('tok_test_decline'), { 'idempotency-key': k });
    expect(first.body.status).toBe('ready_for_complete');
    expect(first.body.messages).toEqual([
      expect.objectContaining({ code: 'payment_failed', severity: 'recoverable' }),
    ]);
    const again = await ucp(alpha, 'POST', path, pay('tok_test_decline'), { 'idempotency-key': k });
    expect(again).toEqual(first);
    const other = await ucp(alpha, 'POST', path, pay(), { 'idempotency-key': k });
    expect(other.status).toBe(409);
  });

  it('cancels an open checkout once', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const path = `/ucp/v1/checkout-sessions/${c.id}/cancel`;
    const r = await ucp(alpha, 'POST', path, undefined, { 'idempotency-key': key() });
    expect(r.body.status).toBe('canceled');
    expect((await ucp(alpha, 'POST', path, undefined, { 'idempotency-key': key() })).status).toBe(
      409,
    );
  });

  it('refuses a platform on a newer UCP version', async () => {
    const future = await platform('future', platformProfile('2099-01-01'));
    const r = await ucp(future, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    expect(r).toMatchObject({ status: 422, body: { code: 'version_unsupported' } });
  });
});

describe('UCP completion and order events', () => {
  it('places the order, which adopts the payment, and tells the platform as it ships', async () => {
    introspector = await introspectWorkflow(env.ORDER_LOOP);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    hooks.length = 0;
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const done = await ucp(alpha, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    expect(done.body.status).toBe('completed');
    const orderId = done.body.order.id;
    expect(done.body.order.permalink_url).toBe(`https://shop.example/orders/${orderId}`);

    const row = await db().select().from(orders).where(eq(orders.id, orderId)).get();
    expect(row).toMatchObject({
      channel: 'agent',
      externalId: c.id,
      flowId: 'tpl-storefront-order',
    });
    const session = await db()
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, c.id))
      .get();
    expect(session).toMatchObject({ status: 'completed', orderId });

    // The order runs to its return window: authorized at the quoted total, shipped, captured.
    const state = await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the return window');
    expect(state.nodes.authorize?.branches).toEqual(['ok']);
    expect(Math.round(state.order!.total * 100)).toBe(c.totals.at(-1).amount);

    // The platform hears about it: signed with the profile's key, the whole order each time.
    const shippedHook = await until(async () => {
      const h = hooks.find((x) => JSON.parse(x.body).fulfillment.events.length);
      return h ? { h, body: h.body } : false;
    }, 'a shipped order event');
    const { h, body } = shippedHook;
    expect(h.headers.get('ucp-agent')).toBe(`profile="${ORIGIN}/.well-known/ucp"`);
    expect(h.headers.get('webhook-id')).toBeTruthy();
    expect(await digestMatches(h.headers.get('content-digest'), body)).toBe(true);
    const profile = (await ucpProfile(env, ORIGIN))!;
    const pub = await importVerifyKey(profile.keys[0]!);
    const check = await verifyMessage(
      { method: 'POST', url: h.url, headers: h.headers },
      async (kid) => (kid === profile.keys[0]!.kid ? pub : null),
      ['@method', '@authority', '@path', 'content-digest', 'ucp-agent'],
    );
    expect(check).toMatchObject({ ok: true });
    const entity = JSON.parse(body);
    expect(entity).toMatchObject({
      id: orderId,
      checkout_id: c.id,
      ucp: { capabilities: { [ORDER_CAPABILITY]: [{ version: UCP_VERSION }] } },
    });
    expect(entity.fulfillment.events[0]).toMatchObject({
      type: 'shipped',
      line_items: [{ id: c.line_items[0].id, quantity: 1 }],
    });

    // Get Order returns the same snapshot.
    const got = await ucp(alpha, 'GET', `/ucp/v1/orders/${orderId}`);
    expect(got.body).toMatchObject({ id: orderId, line_items: [{ status: 'fulfilled' }] });
    // A completed checkout doesn't change, and completing it again places nothing new.
    const repeat = await ucp(alpha, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    expect(repeat.body.order.id).toBe(orderId);
  });
});

describe('UCP and data subject requests', () => {
  it("exports a buyer's checkouts and erases the ones that placed no order", async () => {
    const grace = { ...monitorCheckout, buyer: { email: 'Grace@Example.com' } };
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', grace);
    const exported = await exportDataSubject(env, 'grace@example.com');
    expect(exported.checkouts).toEqual([
      expect.objectContaining({ id: c.id, buyer: { email: 'Grace@Example.com' }, orderId: null }),
    ]);
    expect(await eraseDataSubject(env, 'grace@example.com')).toMatchObject({
      ok: true,
      done: true,
    });
    const left = await db().select().from(checkoutSessions).where(eq(checkoutSessions.id, c.id));
    expect(left).toEqual([]);
  });
});

describe('UCP over MCP', () => {
  let n = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await worker.fetch(
      new Request('https://engine/ucp/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(principalKey, alpha, '/ucp/mcp'),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      }),
      env,
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const meta = () => ({ 'ucp-agent': { profile: alpha.profileUrl } });

  it('lists the checkout and order tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    const r = await rpc('tools/list');
    expect(r.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'create_checkout',
      'get_checkout',
      'update_checkout',
      'complete_checkout',
      'cancel_checkout',
      'get_order',
    ]);
  });

  it('creates and reads a checkout, the UCP body in structuredContent', async () => {
    const created = await rpc('tools/call', {
      name: 'create_checkout',
      arguments: { meta: meta(), checkout: monitorCheckout },
    });
    const c = created.body.result.structuredContent;
    expect(c.status).toBe('ready_for_complete');
    expect(JSON.parse(created.body.result.content[0].text)).toEqual(c);
    const got = await rpc('tools/call', {
      name: 'get_checkout',
      arguments: { meta: meta(), id: c.id },
    });
    expect(got.body.result.structuredContent.id).toBe(c.id);
  });

  it('refuses another profile in meta, and complete without an idempotency key', async () => {
    const wrong = await rpc('tools/call', {
      name: 'get_checkout',
      arguments: { meta: { 'ucp-agent': { profile: 'https://evil.example/p' } }, id: 'chk_x' },
    });
    expect(wrong.body.error).toMatchObject({ code: -32000, data: { code: 'forbidden' } });
    const noKey = await rpc('tools/call', {
      name: 'complete_checkout',
      arguments: { meta: meta(), id: 'chk_x', checkout: pay() },
    });
    expect(noKey.body.error).toMatchObject({
      code: -32000,
      data: { code: 'idempotency_key_required' },
    });
  });
});
