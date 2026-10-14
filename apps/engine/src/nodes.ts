/**
 * Executors for every node type that runs inside one durable `step.do`. Waiting and control-flow
 * nodes (approval, wait_event, wait, loop, end, continue_as_new) are handled by the interpreter
 * itself because they use `step.sleep` / `step.waitForEvent`.
 *
 * An executor returns the branch it took plus optional order and variable patches; the interpreter
 * applies the patches, so they replay deterministically from the memoized step result.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  BASE_CURRENCY,
  durationMs,
  evaluate,
  evaluatePolicy,
  type FlowNode,
  FULFILLMENT_METHOD_LABELS,
  type FulfillmentMethod,
  fromBase,
  interpolate,
  isBuySide,
  money,
  ORDER_CHANNEL_LABELS,
  type Order,
  type OrderLine,
  type PricedBy,
  policyRulesSchema,
  type RunContext,
  resolvePrice,
  stockLines,
  stringList,
  toBase,
  truthy,
} from '@orderloop/core';
import * as ai from './ai';
import * as cx from './connectors';

export type NodeResult = {
  branches?: string[];
  output?: unknown;
  summary?: string;
  order?: Partial<Order>;
  vars?: Record<string, unknown>;
};

export type ExecInput = {
  env: Env;
  node: FlowNode;
  config: Record<string, unknown>;
  ctx: RunContext;
  stepKey: string;
};

type Exec = (i: ExecInput) => Promise<NodeResult>;

const str = (v: unknown, fb = '') => (typeof v === 'string' ? v : fb);
const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
/** Money for step summaries, in the order's currency: "$3,832.05". */
const cash = (n: number, ctx: RunContext) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: ctx.order.currency || 'USD',
  }).format(n);
const lineCount = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/** Recompute subtotal/tax/total from lines, keeping the current tax rate if one was applied. */
export function totals(
  order: Order,
  taxRate?: number,
): Pick<Order, 'subtotal' | 'tax' | 'total' | 'baseTotal'> {
  const subtotal = money(order.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));
  const rate = taxRate ?? (order.subtotal > 0 ? order.tax / order.subtotal : 0);
  const tax = money(subtotal * rate);
  const total = money(subtotal + tax);
  return { subtotal, tax, total, baseTotal: toBase(total, order.fxRate) };
}

const passthrough: Exec = async () => ({ summary: 'Started' });

export const EXECUTORS: Record<string, Exec> = {
  'trigger.manual': passthrough,
  'trigger.webhook': async ({ ctx, config }) => {
    const { channel, externalId } = ctx.order;
    // The summary names the sending system only when the order says which it was (an inbound
    // order's `source`, e.g. "shopify"): the node's own default would repeat or contradict the channel.
    const given = str(ctx.order.meta?.source, '');
    const source = given || str(config.source, '');
    const named = given && given !== channel ? ` (${given})` : '';
    return {
      output: { channel, externalId: externalId ?? null, source },
      summary: `${ORDER_CHANNEL_LABELS[channel]}${externalId ? ` · ${externalId}` : ''}${named}`,
    };
  },
  'trigger.schedule': passthrough,
  'trigger.inventory_threshold': passthrough,
  'trigger.email_po': async ({ ctx }) => ({
    summary: ctx.order.documentKey
      ? `Document ${ctx.order.documentKey.split('/').pop()}`
      : 'Email received',
  }),

  'commerce.validate': async ({ env, ctx }) => {
    const skus = ctx.order.lines.map((l) => l.sku);
    const known = new Map((await cx.getProducts(env, skus)).map((p) => [p.sku, p]));
    const unknown = skus.filter((s) => !known.has(s));
    if (!ctx.order.lines.length) throw new NonRetryableError('Order has no lines');
    if (unknown.length) throw new NonRetryableError(`Unknown SKUs: ${unknown.join(', ')}`);
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    if (ctx.order.customerId && !customer)
      throw new NonRetryableError(`Unknown customer ${ctx.order.customerId}`);
    const lines: OrderLine[] = ctx.order.lines.map((l) => ({
      ...l,
      qty: Math.max(1, Math.round(l.qty)),
      name: l.name ?? known.get(l.sku)!.name,
    }));
    return {
      order: { lines },
      output: { customer: customer?.name ?? null, lines: lines.length },
      summary: `${lineCount(lines.length)}${customer ? ` · ${customer.name}` : ''}`,
    };
  },

  'commerce.price': async ({ env, ctx, config }) => {
    const products = new Map(
      (
        await cx.getProducts(
          env,
          ctx.order.lines.map((l) => l.sku),
        )
      ).map((p) => [p.sku, p]),
    );
    // Buy-side models price at cost and sell-side models run the pricing chain, unless the node says otherwise.
    const buying =
      config.basis === 'cost' || (config.basis === 'auto' && isBuySide(ctx.order.model));
    // Base-currency prices convert at the order's rate, fixed here for the life of the order.
    const fx = await cx.fxRate(env, ctx.order.currency);
    if (fx === null) throw new NonRetryableError(`No exchange rate for ${ctx.order.currency}`);
    const chain = buying ? null : await cx.pricingFor(env, ctx.order.customerId);
    const sources =
      chain?.sources.filter((s) =>
        s.id === 'contract' ? config.useContracts : config.usePriceRules,
      ) ?? [];
    const priced: { sku: string; unitPrice: number; by: PricedBy['source']; rule: string }[] = [];
    const lines = ctx.order.lines.map((l) => {
      const p = products.get(l.sku);
      if (l.unitPrice !== undefined) {
        priced.push({ sku: l.sku, unitPrice: l.unitPrice, by: 'list', rule: 'Given on the order' });
        return l;
      }
      if (!chain) return { ...l, unitPrice: fromBase(p?.cost ?? 0, fx) };
      const r = resolvePrice(l, p?.price ?? 0, sources, chain.rules, {
        customerId: ctx.order.customerId,
        customerTier: chain.tier,
        now: ctx.now,
      });
      const unitPrice = fromBase(r.unitPrice, fx);
      priced.push({ sku: l.sku, unitPrice, by: r.by.source, rule: r.by.name });
      return { ...l, unitPrice };
    });
    const order = { ...ctx.order, lines, fxRate: fx };
    const t = totals(order);
    const bySource = (k: string) => priced.filter((x) => x.by === k).length;
    const notes = [
      ['contract', 'contract'],
      ['price_book', 'price book'],
      ['volume', 'volume'],
    ]
      .map(([k, label]) => [bySource(k!), label] as const)
      .filter(([n]) => n)
      .map(([n, label]) => `${n} ${label}`);
    return {
      order: { lines, fxRate: fx, ...t },
      output: {
        subtotal: t.subtotal,
        currency: ctx.order.currency,
        fxRate: fx,
        contracted: bySource('contract'),
        lines: priced,
      },
      summary: `Subtotal ${cash(t.subtotal, ctx)}${notes.length ? ` · ${notes.join(', ')}` : ''}`,
    };
  },

  'commerce.tax': async ({ ctx, config }) => {
    const rate = num(config.rate, 0.08);
    const t = totals(ctx.order, rate);
    return {
      order: t,
      output: { rate, ...t },
      summary: `Tax ${cash(t.tax, ctx)} · total ${cash(t.total, ctx)}`,
    };
  },

  'commerce.policy': async ({ ctx, config }) => {
    const rules = policyRulesSchema.safeParse(config.rules);
    if (!rules.success)
      throw new NonRetryableError(`Invalid policy rules: ${rules.error.issues[0]?.message}`);
    const r = evaluatePolicy(rules.data, ctx.order, ctx.now);
    return {
      branches: [r.pass ? 'pass' : 'fail'],
      output: r,
      vars: { policyFailures: r.failures },
      summary: r.pass ? `${rules.data.length} rules passed` : r.failures.join('; '),
    };
  },

  'commerce.credit_check': async ({ env, ctx, config }) => {
    const c = await cx.getCustomer(env, ctx.order.customerId);
    if (!c || c.kind !== 'business') {
      const branch = str(config.noAccount, 'over_limit') === 'ok' ? 'ok' : 'over_limit';
      return {
        branches: [branch],
        summary: c ? `No credit account (${c.kind})` : 'Guest checkout (no credit account)',
        output: { available: 0 },
      };
    }
    // Limits and balances are in the base currency; compare the order there too.
    const available = money(c.creditLimit - c.balance);
    const total = ctx.order.baseTotal ?? toBase(ctx.order.total, ctx.order.fxRate);
    const ok = total <= available;
    const local = (n: number) => cash(fromBase(n, ctx.order.fxRate), ctx);
    return {
      branches: [ok ? 'ok' : 'over_limit'],
      output: { limit: c.creditLimit, balance: c.balance, available, currency: BASE_CURRENCY },
      summary: ok
        ? `Within credit (${local(available)} available)`
        : `Over limit by ${local(total - available)}`,
    };
  },

  'commerce.budget_check': async ({ ctx, config }) => {
    const budget = num(config.budget, 25_000);
    const within = (ctx.order.baseTotal ?? toBase(ctx.order.total, ctx.order.fxRate)) <= budget;
    return {
      branches: [within ? 'within' : 'over'],
      output: { budget },
      summary: `${within ? 'Within' : 'Over'} budget of ${budget} ${BASE_CURRENCY}`,
    };
  },

  'commerce.reserve_inventory': async ({ env, ctx, config, stepKey }) => {
    const r = await cx.reserveInventory(env, ctx.order, stepKey);
    const short = r.short.length > 0 && !config.allowBackorder;
    return {
      branches: [short ? 'backorder' : 'ok'],
      output: r,
      summary: short
        ? `Short: ${r.short.join(', ')}`
        : `Reserved ${lineCount(r.reservationIds.length)}`,
    };
  },

  'commerce.authorize_payment': async ({ env, ctx, config, stepKey }) => {
    const r = await cx.authorizePayment(env, ctx.order, stepKey, str(config.method, 'card'));
    const ok = r.status === 'authorized';
    return {
      branches: [ok ? 'ok' : 'declined'],
      output: r,
      summary: ok ? `Authorized ${cash(r.amount, ctx)}` : 'Declined',
    };
  },

  'commerce.capture_payment': async ({ env, ctx, stepKey }) => {
    const r = await cx.capturePayment(env, ctx.order, stepKey);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: r,
      summary: ok ? `Captured ${cash(r.amount, ctx)}` : 'Nothing to capture',
    };
  },

  'commerce.charge': async ({ env, ctx, stepKey }) => {
    const r = await cx.charge(env, ctx.order, stepKey);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: r,
      summary: ok ? `Charged ${cash(r.amount, ctx)}` : 'Charge failed',
    };
  },

  'commerce.refund': async ({ env, ctx, config, stepKey }) => {
    const expr = config.amount;
    const value = expr === undefined || expr === null || expr === '' ? null : evaluate(expr, ctx);
    const requested = value === null || value === undefined ? undefined : Number(value);
    if (requested !== undefined && !(requested >= 0))
      throw new NonRetryableError(`Refund amount is not a number: ${JSON.stringify(value)}`);
    const r = await cx.refund(env, ctx.order, stepKey, requested);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: { ...r, reason: interpolate(str(config.reason), ctx) },
      vars: ok ? { refunded: r.amount } : undefined,
      summary: ok ? `Refunded ${cash(r.amount, ctx)}` : 'Nothing to refund',
    };
  },

  'commerce.invoice': async ({ env, ctx, config, stepKey }) => {
    const terms = str(config.terms, 'due_on_receipt');
    const days = { due_on_receipt: 0, net_15: 15, net_30: 30, net_60: 60 }[terms] ?? 30;
    const due = new Date(ctx.now + days * 86_400_000).toISOString().slice(0, 10);
    const key = await cx.storeDocument(
      env,
      ctx.order.id,
      'invoice',
      `${stepKey.replace('#', '-')}.html`,
      cx.renderDocument(`Invoice ${ctx.order.id}`, ctx.order, { Terms: terms, Due: due }),
    );
    // Only an unpaid invoice to a business customer is owed on account; a paid order, a consumer
    // or a guest has nothing outstanding.
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const owed =
      config.onAccount !== false &&
      customer?.kind === 'business' &&
      (await cx.paidAmount(env, ctx.order.id)) < ctx.order.total;
    if (owed)
      await cx.addToBalance(env, {
        orderId: ctx.order.id,
        stepKey,
        customerId: customer.id,
        amount: toBase(ctx.order.total, ctx.order.fxRate),
      });
    return {
      output: { key, terms, due, onAccount: owed },
      vars: { invoiceKey: key, dueDate: due },
      summary: `${terms} · due ${due}${owed ? ' · on account' : ''}`,
    };
  },

  'commerce.generate_po': async ({ env, ctx, config, stepKey }) => {
    const supplier = interpolate(str(config.supplier, 'Supplier'), ctx) || 'Supplier';
    const key = await cx.storeDocument(
      env,
      ctx.order.id,
      'po',
      `${stepKey.replace('#', '-')}.html`,
      cx.renderDocument(`Purchase order ${ctx.order.id}`, ctx.order, { Supplier: supplier }),
    );
    return {
      output: { key, supplier },
      vars: { poKey: key, supplier },
      summary: `PO to ${supplier}`,
    };
  },

  'commerce.ship': async ({ env, ctx, config, stepKey }) => {
    const r = await cx.createShipment(env, ctx.order, stepKey, str(config.carrier, 'ups'));
    return {
      output: r,
      vars: { tracking: r.tracking },
      summary: `${r.carrier.toUpperCase()} ${r.tracking}`,
    };
  },

  'commerce.return_label': async ({ env, ctx, config, stepKey }) => {
    const r = await cx.createReturnLabel(env, ctx.order, stepKey, str(config.carrier, 'ups'));
    return {
      output: r,
      vars: { returnTracking: r.tracking },
      summary: `Return ${r.carrier.toUpperCase()} ${r.tracking}`,
    };
  },

  'commerce.three_way_match': async ({ ctx, config }) => {
    const received =
      (ctx.vars.goods_received as { total?: number } | undefined)?.total ?? ctx.order.total;
    const invoiced =
      ctx.order.meta?.simulate === 'three_way_mismatch' ? ctx.order.total * 1.1 : ctx.order.total;
    const tol = num(config.tolerance, 0.02);
    const drift =
      Math.max(Math.abs(received - ctx.order.total), Math.abs(invoiced - ctx.order.total)) /
      Math.max(ctx.order.total, 1);
    const match = drift <= tol;
    return {
      branches: [match ? 'match' : 'mismatch'],
      output: { received, invoiced, drift },
      summary: match ? 'PO = receipt = invoice' : `Drift ${(drift * 100).toFixed(1)}%`,
    };
  },

  'commerce.pay_supplier': async ({ env, ctx, stepKey }) => {
    const r = await cx.charge(env, { ...ctx.order, meta: {} }, `ap_${stepKey}`);
    return { output: r, summary: `Scheduled ${cash(r.amount, ctx)}` };
  },

  'commerce.address_validate': async ({ env, ctx }) => {
    const r = await cx.validateAddress(env, ctx.order.meta?.shipTo);
    return {
      branches: [r.status],
      output: r,
      vars: r.status === 'corrected' ? { suggestedAddress: r.address } : undefined,
      summary:
        r.status === 'valid'
          ? 'Address OK'
          : r.status === 'corrected'
            ? 'Suggested a corrected address'
            : r.issues.join('; '),
    };
  },

  'commerce.restock': async ({ env, ctx, config, stepKey }) => {
    const expr = config.lines;
    const requested =
      expr === undefined || expr === null || expr === '' ? null : evaluate(expr, ctx);
    const lines = stockLines(requested, ctx.order.lines);
    await cx.restock(env, ctx.order.id, stepKey, lines);
    return {
      output: { lines },
      summary: `+${lines.reduce((s, l) => s + l.qty, 0)} units`,
    };
  },

  'commerce.erp_sync': async ({ ctx, config }) => {
    const ref = `${str(config.system, 'erp').toUpperCase()}-${ctx.order.id.slice(-8)}`;
    return { output: { ref }, vars: { erpRef: ref }, summary: ref };
  },

  'commerce.route_fulfillment': async ({ env, ctx, config }) => {
    const chosen = str(config.method, 'from_order');
    const method = (chosen === 'from_order' ? (ctx.order.fulfillment?.method ?? 'ship') : chosen) as
      | 'ship'
      | 'pickup'
      | 'carry_out'
      | 'digital';
    const r = await cx.routeFulfillment(env, ctx.order, method === 'digital' ? 'ship' : method);
    const at = (b: string) =>
      !r.locationName ? '' : b === 'ship' ? ` from ${r.locationName}` : ` at ${r.locationName}`;
    return {
      branches: r.branches,
      output: r,
      ...(r.method && r.branches[0] !== 'unavailable'
        ? {
            order: {
              fulfillment: {
                method: r.method,
                ...(r.locationId ? { locationId: r.locationId } : {}),
              },
            },
          }
        : {}),
      vars: { fulfillmentLocation: r.locationName ?? null },
      summary:
        r.branches[0] === 'unavailable'
          ? (r.reason ?? 'Unavailable')
          : r.branches
              .map((b) =>
                b === 'digital'
                  ? 'digital'
                  : `${b === 'pickup' ? 'Pick up' : FULFILLMENT_METHOD_LABELS[b as FulfillmentMethod]}${at(b)}`,
              )
              .join(' + '),
    };
  },

  'commerce.pickup_ready': async ({ env, ctx, stepKey }) => {
    const r = await cx.stagePickup(env, ctx.order, stepKey);
    return {
      output: r,
      vars: { pickupCode: r.pickupCode },
      summary: `Pickup code ${r.pickupCode}`,
    };
  },

  'commerce.handover': async ({ env, ctx, stepKey }) => {
    const r = await cx.handOver(env, ctx.order, stepKey);
    return { output: r, summary: r.collected === 'pickup' ? 'Collected' : 'Carried out' };
  },

  'commerce.deliver_digital': async ({ env, ctx, stepKey }) => {
    const codes = await cx.issueEntitlements(env, ctx.order, stepKey);
    return {
      output: { entitlements: codes },
      vars: { entitlements: codes },
      summary: `${codes.length} ${codes.length === 1 ? 'code' : 'codes'} issued`,
    };
  },

  'commerce.split_by_seller': async ({ env, ctx }) => {
    const res = await cx.splitBySeller(env, ctx.order);
    if (!res.ok) throw new NonRetryableError(res.error);
    const pending = res.parts.filter((p) => p.status === 'pending');
    return {
      branches: [pending.length ? 'awaiting' : 'accepted'],
      output: { parts: res.parts },
      vars: {
        sellers: res.parts.map((p) => p.sellerId),
        pendingSellers: pending.map((p) => p.sellerId),
      },
      summary: `${res.parts.length} ${res.parts.length === 1 ? 'seller' : 'sellers'}${pending.length ? ` · ${pending.length} awaiting` : ''}`,
    };
  },

  'commerce.seller_accept': async ({ env, ctx, config }) => {
    if (str(config.decision, 'from_event') === 'expire_pending') {
      await cx.expireSellerOrders(env, ctx.order.id, 'No response');
    } else {
      const r = (ctx.vars.seller_responded ?? {}) as Record<string, unknown>;
      const decision = r.decision === 'accepted' || r.decision === 'rejected' ? r.decision : null;
      if (typeof r.sellerId !== 'string' || !decision)
        throw new NonRetryableError(
          'seller.responded needs { sellerId, decision: "accepted" | "rejected" }',
        );
      await cx.decideSellerOrder(
        env,
        ctx.order.id,
        r.sellerId,
        decision,
        typeof r.reason === 'string' ? r.reason : undefined,
      );
    }
    const parts = await cx.sellerParts(env, ctx.order.id);
    const pending = parts.filter((p) => p.status === 'pending');
    const accepted = parts.filter((p) => p.status === 'accepted');
    const rejected = parts.filter((p) => p.status === 'rejected');
    const output = { parts };
    if (pending.length)
      return {
        branches: ['pending'],
        output,
        vars: { pendingSellers: pending.map((p) => p.sellerId) },
        summary: `${pending.length} still to answer`,
      };
    if (!accepted.length) return { branches: ['rejected'], output, summary: 'No seller accepted' };
    if (!rejected.length)
      return { branches: ['accepted'], output, summary: `All ${accepted.length} accepted` };
    // Keep only the lines of sellers that accepted, and re-total.
    const keep = new Set(accepted.map((p) => p.sellerId));
    const products = new Map(
      (
        await cx.getProducts(
          env,
          ctx.order.lines.map((l) => l.sku),
        )
      ).map((p) => [p.sku, p]),
    );
    const lines = ctx.order.lines.filter((l) =>
      keep.has(l.sellerId ?? products.get(l.sku)?.sellerId ?? cx.FIRST_PARTY),
    );
    return {
      branches: ['partial'],
      output,
      order: { lines, ...totals({ ...ctx.order, lines }) },
      vars: { rejectedSellers: rejected.map((p) => p.sellerId) },
      summary: `${accepted.length} accepted, ${rejected.length} rejected (${rejected.map((p) => p.name).join(', ')})`,
    };
  },

  'commerce.payout': async ({ env, ctx, stepKey }) => {
    const rows = await cx.schedulePayouts(env, ctx.order, stepKey);
    const net = money(rows.reduce((s, r) => s + r.net, 0));
    const commission = money(rows.reduce((s, r) => s + r.commission, 0));
    return {
      output: { payouts: rows },
      vars: { commission, payouts: rows.map((r) => ({ sellerId: r.sellerId, net: r.net })) },
      summary: rows.length
        ? `${rows.length} ${rows.length === 1 ? 'payout' : 'payouts'} · ${cash(net, ctx)} net, ${cash(commission, ctx)} commission`
        : 'No third-party sellers',
    };
  },

  'commerce.notify': async ({ env, ctx, config, stepKey }) => {
    const to = str(config.to, 'customer');
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const recipient =
      to === 'customer'
        ? (customer?.email ?? ctx.order.contact?.email ?? 'customer')
        : to === 'supplier'
          ? str(ctx.vars.supplier, 'supplier')
          : 'team';
    const subject = interpolate(str(config.subject), ctx);
    const body = interpolate(str(config.body), ctx) || subject;
    if (to === 'seller') {
      const sellers = await cx.sellerContacts(env, ctx.order.id);
      const sent = [];
      for (const s of sellers)
        sent.push(
          await cx.sendMessage(env, ctx.order.id, `${stepKey}:${s.id}`, s.email, subject, body),
        );
      return {
        output: { messages: sent },
        summary: `→ ${sent.length} ${sent.length === 1 ? 'seller' : 'sellers'}: ${subject}`,
      };
    }
    const r = await cx.sendMessage(env, ctx.order.id, stepKey, recipient, subject, body);
    return { output: r, summary: `→ ${recipient}: ${subject}` };
  },

  // ── Control (pure, but inside a step so `now` and friends replay identically) ──
  'control.condition': async ({ config, ctx }) => {
    const v = truthy(config.expression, ctx);
    return {
      branches: [v ? 'true' : 'false'],
      output: { value: v },
      summary: v ? 'true' : 'false',
    };
  },

  'control.set': async ({ config, ctx }) => {
    const assign = (config.assign ?? {}) as Record<string, unknown>;
    const vars = Object.fromEntries(
      Object.entries(assign).map(([k, expr]) => [k, evaluate(expr, ctx)]),
    );
    return {
      vars,
      output: vars,
      summary: Object.entries(vars)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', '),
    };
  },

  // ── AI ─────────────────────────────────────────────────────────────────────
  'ai.extract': async ({ env, ctx }) => {
    let text = ctx.order.documentText ?? '';
    if (!text && ctx.order.documentKey)
      text = (await (await env.DOCS.get(ctx.order.documentKey))?.text()) ?? '';
    if (!text) return { summary: 'No document; using order as given', output: { skipped: true } };
    const catalog = (await cx.getProducts(env)).map((p) => ({ sku: p.sku, name: p.name }));
    const { value, source } = await ai.extractOrder(env, text, catalog);
    const customer = ctx.order.customerId
      ? undefined
      : value.customerName
        ? await cx.findCustomerByName(env, value.customerName)
        : undefined;
    const known = new Set(catalog.map((c) => c.sku));
    const lines = value.lines
      .filter((l) => known.has(String(l.sku).toUpperCase()) && l.qty > 0)
      .map((l) => ({ sku: String(l.sku).toUpperCase(), qty: Math.round(l.qty) }));
    return {
      order: {
        ...(lines.length ? { lines } : {}),
        ...(customer ? { customerId: customer.id } : {}),
        ...(value.poNumber
          ? {
              title: `${['b2b', 'procurement'].includes(ctx.order.model) ? 'PO' : 'Ref'} ${value.poNumber}`,
            }
          : {}),
      },
      output: { ...value, source },
      vars: { poNumber: value.poNumber },
      summary: `${lineCount(lines.length)}${customer ? ` · ${customer.name}` : ''} (${source})`,
    };
  },

  'ai.classify': async ({ env, ctx, config }) => {
    const labels = stringList(config.labels, ['other']);
    const { value, source } = await ai.classify(env, ctx.order, labels);
    return {
      vars: { [str(config.into, 'category')]: value.label },
      output: { ...value, source },
      summary: `${value.label} (${Math.round(value.confidence * 100)}%)`,
    };
  },

  'ai.risk_score': async ({ env, ctx, config }) => {
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const { value, source } = await ai.riskScore(env, ctx.order, customer);
    const high = value.score >= num(config.threshold, 70);
    return {
      branches: [high ? 'high' : 'low'],
      vars: { risk: value.score },
      output: { ...value, source },
      summary: `Risk ${Math.round(value.score)}${value.reasons[0] ? ` · ${value.reasons[0]}` : ''}`,
    };
  },

  'ai.forecast': async ({ env, ctx, config }) => {
    const stock = await cx.getProducts(env);
    const { value, source } = await ai.forecast(env, stock, num(config.horizonDays, 30));
    const bySku = new Map(stock.map((p) => [p.sku, p]));
    const lines = value.lines.map((l) => ({
      sku: l.sku,
      qty: Math.round(l.qty),
      name: bySku.get(l.sku)?.name,
    }));
    const supplier = lines.length ? bySku.get(lines[0]!.sku)?.supplier : undefined;
    return {
      order: lines.length ? { lines } : { lines: ctx.order.lines },
      vars: supplier ? { supplier } : {},
      output: { ...value, source },
      summary: lines.length ? `${lines.length} SKUs to reorder (${source})` : 'Stock is healthy',
    };
  },

  'ai.summarize': async ({ env, ctx, config }) => {
    const { value, source } = await ai.summarize(env, {
      order: ctx.order,
      vars: ctx.vars,
      nodes: ctx.nodes,
    });
    return {
      vars: { [str(config.into, 'summary')]: value.summary },
      output: { ...value, source },
      summary: value.summary.slice(0, 80),
    };
  },

  'ai.router': async ({ env, ctx, config }) => {
    const routes = stringList(config.routes, ['auto_approve', 'needs_approval']);
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const { value, source } = await ai.route(
      env,
      str(config.instructions, 'Decide how to handle this order.'),
      routes,
      {
        order: ctx.order,
        customer,
        vars: ctx.vars,
        completed: ctx.nodes,
      },
    );
    return { branches: [value.route], output: { ...value, source }, summary: `→ ${value.route}` };
  },
};

/** Saga compensations, registered on the step when the node type declares `rollback`. */
export const ROLLBACKS: Record<
  string,
  (env: Env, orderId: string, output: unknown) => Promise<string>
> = {
  'commerce.reserve_inventory': async (env, orderId) =>
    `Released ${await cx.releaseInventory(env, orderId)} reservations`,
  'commerce.authorize_payment': async (env, orderId) =>
    `Voided ${await cx.voidAuthorizations(env, orderId)} authorizations`,
  'commerce.pickup_ready': async (env, _orderId, output) => {
    const id = (output as { shipmentId?: string } | undefined)?.shipmentId;
    if (id) await cx.cancelShipment(env, id);
    return id ? `Cancelled pickup ${id}` : 'No pickup to cancel';
  },
  'commerce.deliver_digital': async (env, orderId) =>
    `Revoked ${await cx.revokeEntitlements(env, orderId)} codes`,
  'commerce.split_by_seller': async (env, orderId) =>
    `Cancelled ${await cx.cancelSellerOrders(env, orderId)} seller orders`,
  'commerce.payout': async (env, orderId) =>
    `Reversed ${await cx.reversePayouts(env, orderId)} payouts`,
  'commerce.ship': async (env, _orderId, output) => {
    const id = (output as { shipmentId?: string } | undefined)?.shipmentId;
    if (id) await cx.cancelShipment(env, id);
    return id ? `Cancelled shipment ${id}` : 'No shipment to cancel';
  },
};

/** Applies TIME_SCALE so demos compress days into minutes. Never below one second. */
export function scaled(env: Env, duration: string): number {
  const scale = Math.max(1, Number(env.TIME_SCALE) || 1);
  return Math.max(1000, Math.round(durationMs(duration) / scale));
}
