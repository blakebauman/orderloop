/**
 * An in-memory Stripe for the `stripe` test project, installed over `globalThis.fetch`. It models
 * what the payment gateway relies on: PaymentIntent states (manual capture, cancel, off-session
 * confirms), refunds against what was received, customers, card declines, and idempotency keys
 * (a repeated key replays the first response; a different body under it is refused). Requests to
 * anything other than api.stripe.com go to the real fetch.
 */

import { vi } from 'vitest';

type Json = Record<string, unknown>;
type Form = { [k: string]: string | Form };

export type FakeIntent = {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  status: string;
  capture_method: string;
  customer: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
  off_session: boolean;
  setup_future_usage: string | null;
  refunded: number;
};

export type StripeCall = {
  method: string;
  path: string;
  params: Form;
  idempotencyKey: string | null;
  version: string | null;
  auth: string | null;
};

/** `a[b][c]=1` → `{a: {b: {c: '1'}}}`. Arrays come back as objects keyed "0", "1"…. */
export function parseForm(body: string): Form {
  const out: Form = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.replace(/\]/g, '').split('[');
    let at = out;
    for (const [i, k] of path.entries()) {
      if (i === path.length - 1) at[k] = value;
      else {
        at[k] ??= {};
        at = at[k] as Form;
      }
    }
  }
  return out;
}

const DECLINING = /chargeDeclined|declined/i;
/** Ids stay unique across fakes, as Stripe's do, since D1 keeps rows between tests. */
let seq = 0;

export function installStripeFake() {
  const realFetch = globalThis.fetch;
  const intents = new Map<string, FakeIntent>();
  const refunds = new Map<string, Json>();
  const customers = new Map<string, Json>();
  const idempotent = new Map<string, { body: string; status: number; json: Json }>();
  const calls: StripeCall[] = [];
  /** Paths whose next request is processed but whose response is lost (a network error). */
  const dropAfter: RegExp[] = [];
  /** Paths whose next request fails with a 500 before Stripe does anything. */
  const failBefore: RegExp[] = [];
  const nextId = (prefix: string) => `${prefix}_fake${(++seq).toString().padStart(6, '0')}`;

  const error = (status: number, e: Json) => ({ status, json: { error: e } });
  const ok = (json: Json) => ({ status: 200, json });
  const view = (pi: FakeIntent) => {
    const { refunded: _r, off_session: _o, setup_future_usage: _s, ...rest } = pi;
    return { ...rest } as Json;
  };
  const unexpected = (pi: FakeIntent, what: string) =>
    error(400, {
      type: 'invalid_request_error',
      code: 'payment_intent_unexpected_state',
      message: `You cannot ${what} this PaymentIntent because it has a status of ${pi.status}.`,
      payment_intent: view(pi),
    });

  function createIntent(p: Form) {
    const pi: FakeIntent = {
      id: nextId('pi'),
      object: 'payment_intent',
      amount: Number(p.amount),
      amount_capturable: 0,
      amount_received: 0,
      currency: String(p.currency),
      status: 'requires_payment_method',
      capture_method: String(p.capture_method ?? 'automatic'),
      customer: (p.customer as string) ?? null,
      payment_method: (p.payment_method as string) ?? null,
      metadata: (p.metadata as Record<string, string>) ?? {},
      off_session: p.off_session === 'true',
      setup_future_usage: (p.setup_future_usage as string) ?? null,
      refunded: 0,
    };
    if (!(pi.amount > 0) || !Number.isInteger(pi.amount))
      return error(400, { type: 'invalid_request_error', param: 'amount', message: 'Bad amount' });
    if (pi.customer && !customers.has(pi.customer))
      return error(400, {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `No such customer: '${pi.customer}'`,
      });
    if (pi.setup_future_usage && !pi.customer)
      return error(400, {
        type: 'invalid_request_error',
        param: 'setup_future_usage',
        message: 'setup_future_usage needs a customer',
      });
    intents.set(pi.id, pi);
    if (p.confirm !== 'true') return ok(view(pi));
    if (!pi.payment_method)
      return error(400, { type: 'invalid_request_error', message: 'No payment method' });
    if (DECLINING.test(pi.payment_method)) {
      pi.status = 'requires_payment_method';
      return error(402, {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'generic_decline',
        message: 'Your card was declined.',
        payment_intent: view(pi),
      });
    }
    if (pi.capture_method === 'manual') {
      pi.status = 'requires_capture';
      pi.amount_capturable = pi.amount;
    } else {
      pi.status = 'succeeded';
      pi.amount_received = pi.amount;
    }
    return ok(view(pi));
  }

  function handle(method: string, path: string, p: Form): { status: number; json: Json } {
    if (method === 'POST' && path === '/v1/customers') {
      const c = {
        id: nextId('cus'),
        object: 'customer',
        email: p.email ?? null,
        metadata: p.metadata ?? {},
      };
      customers.set(c.id as string, c);
      return ok(c);
    }
    if (method === 'POST' && path === '/v1/payment_intents') return createIntent(p);
    const m = /^\/v1\/payment_intents\/([^/]+)(?:\/(capture|cancel))?$/.exec(path);
    if (m) {
      const pi = intents.get(decodeURIComponent(m[1]!));
      if (!pi)
        return error(404, {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: `No such payment_intent: '${m[1]}'`,
        });
      if (method === 'GET' && !m[2]) return ok(view(pi));
      if (m[2] === 'capture') {
        if (pi.status !== 'requires_capture') return unexpected(pi, 'capture');
        const amount =
          p.amount_to_capture === undefined ? pi.amount_capturable : Number(p.amount_to_capture);
        if (!(amount > 0) || amount > pi.amount_capturable)
          return error(400, {
            type: 'invalid_request_error',
            param: 'amount_to_capture',
            message: 'amount_to_capture is more than amount_capturable',
          });
        pi.status = 'succeeded';
        pi.amount_received = amount;
        pi.amount_capturable = 0;
        return ok(view(pi));
      }
      if (m[2] === 'cancel') {
        if (pi.status === 'canceled' || pi.status === 'succeeded') return unexpected(pi, 'cancel');
        pi.status = 'canceled';
        pi.amount_capturable = 0;
        return ok(view(pi));
      }
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const pi = intents.get(String(p.payment_intent));
      if (!pi)
        return error(404, {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: 'No such payment_intent',
        });
      const left = pi.amount_received - pi.refunded;
      const amount = p.amount === undefined ? left : Number(p.amount);
      if (pi.status !== 'succeeded' || left <= 0)
        return error(400, {
          type: 'invalid_request_error',
          code: 'charge_already_refunded',
          message: 'Charge has already been refunded.',
        });
      if (!(amount > 0) || amount > left)
        return error(400, {
          type: 'invalid_request_error',
          code: 'amount_too_large',
          message: `Refund amount (${amount}) is greater than unrefunded amount (${left}).`,
        });
      pi.refunded += amount;
      const r = {
        id: nextId('re'),
        object: 'refund',
        amount,
        currency: pi.currency,
        payment_intent: pi.id,
        status: 'succeeded',
        metadata: p.metadata ?? {},
      };
      refunds.set(r.id, r);
      return ok(r);
    }
    return error(404, {
      type: 'invalid_request_error',
      message: `Unrecognized request URL (${method}: ${path})`,
    });
  }

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init as RequestInit);
    const url = new URL(req.url);
    if (url.hostname !== 'api.stripe.com') return realFetch(input as RequestInfo, init);
    // The client sends a string body; reading it from `init` avoids workerd's form-body warning.
    const raw = (init as RequestInit | undefined)?.body;
    const body =
      req.method === 'GET'
        ? url.search.slice(1)
        : typeof raw === 'string'
          ? raw
          : new TextDecoder().decode(await req.arrayBuffer());
    const params = parseForm(body);
    const key = req.headers.get('Idempotency-Key');
    calls.push({
      method: req.method,
      path: url.pathname,
      params,
      idempotencyKey: key,
      version: req.headers.get('Stripe-Version'),
      auth: req.headers.get('Authorization'),
    });
    const reply = (r: { status: number; json: Json }) =>
      new Response(JSON.stringify(r.json), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });

    const fail = failBefore.findIndex((re) => re.test(url.pathname));
    if (fail >= 0) {
      failBefore.splice(fail, 1);
      return reply(error(500, { type: 'api_error', message: 'Something went wrong on our end' }));
    }
    const scope = `${req.method} ${url.pathname}`;
    let result: { status: number; json: Json };
    const seen = key ? idempotent.get(key) : undefined;
    if (seen) {
      result =
        seen.body === `${scope}?${body}`
          ? seen
          : error(400, {
              type: 'idempotency_error',
              message: 'Keys for idempotent requests can only be used with the same parameters',
            });
    } else {
      result = handle(req.method, url.pathname, params);
      // Stripe saves the result of any request that began executing (not 5xx we never ran).
      if (key && req.method === 'POST')
        idempotent.set(key, { body: `${scope}?${body}`, ...result });
    }
    const drop = dropAfter.findIndex((re) => re.test(url.pathname));
    if (drop >= 0) {
      dropAfter.splice(drop, 1);
      throw new TypeError('Network connection lost');
    }
    return reply(result);
  });

  return {
    intents,
    refunds,
    customers,
    calls,
    /** Only Stripe calls for `path` (exact) or matching the regex. */
    callsTo(method: string, path: string | RegExp) {
      return calls.filter(
        (c) =>
          c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)),
      );
    },
    /** The next request to a matching path is carried out, but the caller never hears back. */
    loseNextResponse(path: RegExp) {
      dropAfter.push(path);
    },
    /** The next request to a matching path fails with a 500, untouched. */
    failNext(path: RegExp) {
      failBefore.push(path);
    },
    /** A PaymentIntent made elsewhere (a checkout), authorized and waiting for capture. */
    authorizedIntent(amount: number, currency = 'usd', metadata: Record<string, string> = {}) {
      const r = createIntent({
        amount: String(amount),
        currency,
        capture_method: 'manual',
        confirm: 'true',
        payment_method: 'pm_card_visa',
        metadata,
      });
      return r.json as unknown as FakeIntent;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

export type StripeFake = ReturnType<typeof installStripeFake>;
