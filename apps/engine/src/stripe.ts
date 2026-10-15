/**
 * A small Stripe REST client over `fetch`: form-encoded requests, a pinned API version, an
 * `Idempotency-Key` on every write, and typed errors. No SDK and no internal retries: a failed call
 * throws, and the Workflow step around it retries with the same key, so Stripe replays the first
 * result instead of acting twice.
 */

/** The API version every request pins, so a Stripe account upgrade never changes our payloads. */
export const STRIPE_API_VERSION = '2025-09-30.clover';

const API = 'https://api.stripe.com';

export type StripeParams = { [key: string]: StripeValue };
type StripeValue = string | number | boolean | null | undefined | StripeValue[] | StripeParams;

/** Stripe's error body, as a thrown error. `type` is card_error, invalid_request_error, api_error… */
export class StripeError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code?: string;
  readonly declineCode?: string;
  readonly param?: string;
  /** The PaymentIntent the error is about, when Stripe includes it (card errors, bad states). */
  readonly paymentIntent?: PaymentIntent;

  constructor(
    status: number,
    body: {
      type?: string;
      code?: string;
      decline_code?: string;
      param?: string;
      message?: string;
      payment_intent?: PaymentIntent;
    },
  ) {
    super(body.message ?? `Stripe request failed (${status})`);
    this.name = 'StripeError';
    this.status = status;
    this.type = body.type ?? 'api_error';
    this.code = body.code;
    this.declineCode = body.decline_code;
    this.param = body.param;
    this.paymentIntent = body.payment_intent;
  }

  /** The card was refused or needs the customer: take the declined branch, don't retry. */
  get isCardError() {
    return this.type === 'card_error';
  }

  /** Worth retrying the same request: Stripe's side, rate limits, or a key still in flight. */
  get isRetryable() {
    return this.status >= 500 || this.status === 429 || this.status === 409;
  }
}

export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export type PaymentIntent = {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  status: PaymentIntentStatus;
  capture_method: 'automatic' | 'automatic_async' | 'manual';
  customer: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
};

export type Refund = {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  payment_intent: string | null;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
};

export type Customer = { id: string; object: 'customer'; email: string | null };

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

export type Invoice = {
  id: string;
  object: 'invoice';
  status: InvoiceStatus;
  customer: string;
  currency: string;
  /** Minor units. */
  total: number;
  amount_due: number;
  amount_paid: number;
  number: string | null;
  hosted_invoice_url: string | null;
  due_date: number | null;
  metadata: Record<string, string>;
};

export type InvoiceItem = {
  id: string;
  object: 'invoiceitem';
  amount: number;
  currency: string;
  invoice: string | null;
};

/** A webhook event, as Stripe POSTs it. `data.object` is the resource it is about. */
export type StripeEvent = {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> & { id: string; object: string } };
};

/** `{a: {b: 1}, c: [x]}` → `a[b]=1&c[0]=x`, as Stripe's form API nests parameters. */
export function encodeForm(params: StripeParams): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: StripeValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) for (const [i, item] of v.entries()) walk(`${prefix}[${i}]`, item);
    else if (typeof v === 'object')
      for (const [k, item] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, item);
    else out.append(prefix, String(v));
  };
  walk('', params);
  return out.toString();
}

export type StripeClient = ReturnType<typeof stripeClient>;

export function stripeClient(secretKey: string) {
  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params?: StripeParams,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    let url = `${API}${path}`;
    let body: string | undefined;
    if (method !== 'POST') {
      const q = params ? encodeForm(params) : '';
      if (q) url += `?${q}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = params ? encodeForm(params) : '';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const err = (json as { error?: ConstructorParameters<typeof StripeError>[1] }).error ?? {};
      throw new StripeError(res.status, err);
    }
    return json as T;
  }

  const post = <T>(path: string, params: StripeParams, key: string) =>
    request<T>('POST', path, params, key);
  const invoice = (id: string) => `/v1/invoices/${encodeURIComponent(id)}`;

  return {
    /** Live or test: test keys may use Stripe's test payment methods (pm_card_visa…). */
    testMode: /^(sk|rk)_test_/.test(secretKey),
    paymentIntents: {
      create: (params: StripeParams, key: string) =>
        post<PaymentIntent>('/v1/payment_intents', params, key),
      retrieve: (id: string) =>
        request<PaymentIntent>('GET', `/v1/payment_intents/${encodeURIComponent(id)}`),
      capture: (id: string, params: StripeParams, key: string) =>
        post<PaymentIntent>(`/v1/payment_intents/${encodeURIComponent(id)}/capture`, params, key),
      cancel: (id: string, params: StripeParams, key: string) =>
        post<PaymentIntent>(`/v1/payment_intents/${encodeURIComponent(id)}/cancel`, params, key),
    },
    refunds: {
      create: (params: StripeParams, key: string) => post<Refund>('/v1/refunds', params, key),
    },
    customers: {
      create: (params: StripeParams, key: string) => post<Customer>('/v1/customers', params, key),
    },
    invoices: {
      create: (params: StripeParams, key: string) => post<Invoice>('/v1/invoices', params, key),
      retrieve: (id: string) => request<Invoice>('GET', invoice(id)),
      finalize: (id: string, params: StripeParams, key: string) =>
        post<Invoice>(`${invoice(id)}/finalize`, params, key),
      send: (id: string, key: string) => post<Invoice>(`${invoice(id)}/send`, {}, key),
      void: (id: string, key: string) => post<Invoice>(`${invoice(id)}/void`, {}, key),
      /** Only a draft can be deleted; a finalized invoice is voided instead. */
      del: (id: string) => request<{ id: string; deleted: boolean }>('DELETE', invoice(id)),
    },
    invoiceItems: {
      create: (params: StripeParams, key: string) =>
        post<InvoiceItem>('/v1/invoiceitems', params, key),
    },
  };
}
