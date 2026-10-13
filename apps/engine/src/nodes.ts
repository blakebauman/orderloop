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
  durationMs,
  evaluate,
  type FlowNode,
  interpolate,
  money,
  type Order,
  type OrderLine,
  type RunContext,
  stringList,
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

/** Recompute subtotal/tax/total from lines, keeping the current tax rate if one was applied. */
export function totals(order: Order, taxRate?: number): Pick<Order, 'subtotal' | 'tax' | 'total'> {
  const subtotal = money(order.lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));
  const rate = taxRate ?? (order.subtotal > 0 ? order.tax / order.subtotal : 0);
  const tax = money(subtotal * rate);
  return { subtotal, tax, total: money(subtotal + tax) };
}

const passthrough: Exec = async () => ({ summary: 'Started' });

export const EXECUTORS: Record<string, Exec> = {
  'trigger.manual': passthrough,
  'trigger.webhook': passthrough,
  'trigger.schedule': passthrough,
  'trigger.inventory_threshold': passthrough,
  'trigger.email_po': async ({ ctx }) => ({
    summary: ctx.order.documentKey
      ? `Document ${ctx.order.documentKey.split('/').pop()}`
      : 'PO received',
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
      summary: `${lines.length} lines${customer ? ` · ${customer.name}` : ''}`,
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
    const contracts =
      config.useContracts && ctx.order.customerId
        ? await cx.contractPricesFor(env, ctx.order.customerId)
        : new Map<string, number>();
    // Replenishment and procurement buy at cost; selling flows use list or contract price.
    const buying = ctx.order.type === 'reorder' || ctx.order.type === 'purchase_request';
    let contracted = 0;
    const lines = ctx.order.lines.map((l) => {
      const p = products.get(l.sku);
      const c = contracts.get(l.sku);
      if (c !== undefined) contracted++;
      const unitPrice = l.unitPrice ?? c ?? (buying ? p?.cost : p?.price) ?? 0;
      return { ...l, unitPrice };
    });
    const order = { ...ctx.order, lines };
    const t = totals(order);
    return {
      order: { lines, ...t },
      output: { subtotal: t.subtotal, contracted },
      summary: `Subtotal ${t.subtotal.toFixed(2)}${contracted ? ` · ${contracted} contract prices` : ''}`,
    };
  },

  'commerce.tax': async ({ ctx, config }) => {
    const rate = num(config.rate, 0.08);
    const t = totals(ctx.order, rate);
    return {
      order: t,
      output: { rate, ...t },
      summary: `Tax ${t.tax.toFixed(2)} · total ${t.total.toFixed(2)}`,
    };
  },

  'commerce.credit_check': async ({ env, ctx }) => {
    const c = await cx.getCustomer(env, ctx.order.customerId);
    if (!c)
      return { branches: ['over_limit'], summary: 'No credit account', output: { available: 0 } };
    const available = money(c.creditLimit - c.balance);
    const ok = ctx.order.total <= available;
    return {
      branches: [ok ? 'ok' : 'over_limit'],
      output: { limit: c.creditLimit, balance: c.balance, available },
      summary: ok
        ? `Within credit (${available.toFixed(0)} available)`
        : `Over limit by ${(ctx.order.total - available).toFixed(0)}`,
    };
  },

  'commerce.budget_check': async ({ ctx, config }) => {
    const budget = num(config.budget, 25_000);
    const within = ctx.order.total <= budget;
    return {
      branches: [within ? 'within' : 'over'],
      output: { budget },
      summary: `${within ? 'Within' : 'Over'} budget of ${budget}`,
    };
  },

  'commerce.reserve_inventory': async ({ env, ctx, config, stepKey }) => {
    const r = await cx.reserveInventory(env, ctx.order, stepKey);
    const short = r.short.length > 0 && !config.allowBackorder;
    return {
      branches: [short ? 'backorder' : 'ok'],
      output: r,
      summary: short ? `Short: ${r.short.join(', ')}` : `Reserved ${r.reservationIds.length} lines`,
    };
  },

  'commerce.authorize_payment': async ({ env, ctx, config, stepKey }) => {
    const r = await cx.authorizePayment(env, ctx.order, stepKey, str(config.method, 'card'));
    const ok = r.status === 'authorized';
    return {
      branches: [ok ? 'ok' : 'declined'],
      output: r,
      summary: ok ? `Authorized ${r.amount.toFixed(2)}` : 'Declined',
    };
  },

  'commerce.capture_payment': async ({ env, ctx, stepKey }) => {
    const r = await cx.capturePayment(env, ctx.order, stepKey);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: r,
      summary: ok ? `Captured ${r.amount.toFixed(2)}` : 'Nothing to capture',
    };
  },

  'commerce.charge': async ({ env, ctx, stepKey }) => {
    const r = await cx.charge(env, ctx.order, stepKey);
    const ok = r.status === 'succeeded';
    return {
      branches: [ok ? 'ok' : 'failed'],
      output: r,
      summary: ok ? `Charged ${r.amount.toFixed(2)}` : 'Charge failed',
    };
  },

  'commerce.invoice': async ({ env, ctx, config, stepKey }) => {
    const terms = str(config.terms, 'net_30');
    const days = { due_on_receipt: 0, net_15: 15, net_30: 30, net_60: 60 }[terms] ?? 30;
    const due = new Date(ctx.now + days * 86_400_000).toISOString().slice(0, 10);
    const key = await cx.storeDocument(
      env,
      ctx.order.id,
      'invoice',
      `${stepKey.replace('#', '-')}.html`,
      cx.renderDocument(`Invoice ${ctx.order.id}`, ctx.order, { Terms: terms, Due: due }),
    );
    await cx.addToBalance(env, ctx.order.customerId, ctx.order.total);
    return {
      output: { key, terms, due },
      vars: { invoiceKey: key, dueDate: due },
      summary: `${terms} · due ${due}`,
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
    return { output: r, summary: `Scheduled ${r.amount.toFixed(2)}` };
  },

  'commerce.restock': async ({ env, ctx }) => {
    await cx.restock(env, ctx.order);
    return { summary: `+${ctx.order.lines.reduce((s, l) => s + l.qty, 0)} units` };
  },

  'commerce.erp_sync': async ({ ctx, config }) => {
    const ref = `${str(config.system, 'erp').toUpperCase()}-${ctx.order.id.slice(-8)}`;
    return { output: { ref }, vars: { erpRef: ref }, summary: ref };
  },

  'commerce.notify': async ({ env, ctx, config, stepKey }) => {
    const to = str(config.to, 'customer');
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const recipient =
      to === 'customer'
        ? (customer?.email ?? 'customer')
        : to === 'supplier'
          ? str(ctx.vars.supplier, 'supplier')
          : 'team';
    const subject = interpolate(str(config.subject), ctx);
    const body = interpolate(str(config.body), ctx) || subject;
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
        ...(value.poNumber ? { title: `PO ${value.poNumber}` } : {}),
      },
      output: { ...value, source },
      vars: { poNumber: value.poNumber },
      summary: `${lines.length} lines${customer ? ` · ${customer.name}` : ''} (${source})`,
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
