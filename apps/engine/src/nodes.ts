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
  type AiProvenance,
  type AppliedPromotion,
  applyPromotion,
  assessBranch,
  assessQuestionsSchema,
  BASE_CURRENCY,
  billableKg,
  checkAddress,
  choosePromotions,
  computeTotals,
  describeAnswers,
  durationMs,
  evaluate,
  evaluatePolicy,
  type FlowNode,
  FULFILLMENT_METHOD_LABELS,
  type FulfillmentMethod,
  fromBase,
  getPath,
  interpolate,
  isBuySide,
  money,
  type NodeRegistry,
  ORDER_CHANNEL_LABELS,
  type Order,
  type OrderLine,
  PROVIDER_MAX_TAX_RATE,
  type PricedBy,
  type Promotion,
  pickOption,
  policyRulesSchema,
  promoCodesOf,
  promotionProblem,
  type RunContext,
  regionalTaxRate,
  resolvePrice,
  SHIPPING_SELECTIONS,
  type ShippingSelection,
  shippingConfigSchema,
  shipToCountry,
  stockLines,
  stringList,
  taxRegionsSchema,
  toBase,
  truthy,
  unknownPromotion,
} from '@orderloop/core';
import * as ai from './ai';
import * as billing from './billing';
import * as clef from './clef';
import * as cx from './connectors';
import { provide } from './providers';

export type NodeResult = {
  branches?: string[];
  output?: unknown;
  summary?: string;
  order?: Partial<Order>;
  vars?: Record<string, unknown>;
  /** A plugin node's variables, merged into `vars.plugins[id]` (never over the flow's own). */
  pluginVars?: { id: string; vars: Record<string, unknown> };
};

export type ExecInput = {
  env: Env;
  node: FlowNode;
  config: Record<string, unknown>;
  ctx: RunContext;
  stepKey: string;
  /** The node types this run was planned with (its `load-plugins` snapshot, for plugin nodes). */
  registry?: NodeRegistry;
  /**
   * Pricing a checkout or cart (`quoteCheckout`), not running an order: nothing is written, so a
   * quote never redeems a promotion.
   */
  dryRun?: boolean;
  /**
   * The step has attempts left: a failed model call throws so the step retries, rather than
   * answering with the heuristic. Unset on the last attempt and outside a step.
   */
  retriesLeft?: boolean;
};

type Exec = (i: ExecInput) => Promise<NodeResult>;

/** How an AI node calls the model from its step (see `AiCall`). */
const aiCall = ({ ctx, retriesLeft }: ExecInput): ai.AiCall => ({
  retry: !!retriesLeft,
  orderId: ctx.order.id,
});

/**
 * The model didn't answer, outside mock mode. A risk score or route the heuristic made up must not
 * pass an order a model would have stopped, so those nodes fail closed on it.
 */
const unchecked = (via: AiProvenance) => via.source === 'heuristic' && via.fallback !== 'mock';

const str = (v: unknown, fb = '') => (typeof v === 'string' ? v : fb);
const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
/** Money for step summaries, in the order's currency: "$3,832.05". */
const cash = (n: number, ctx: RunContext) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: ctx.order.currency || 'USD',
  }).format(n);
const lineCount = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/** The plugin a node's Provider field names, or null for the built-in connector. */
const providerOf = (config: Record<string, unknown>) =>
  typeof config.provider === 'string' && config.provider && config.provider !== 'builtin'
    ? config.provider
    : null;

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
  'trigger.email_po': async ({ ctx }) => {
    const { channel, documentKey, externalId } = ctx.order;
    if (documentKey) return { summary: `Document ${documentKey.split('/').pop()}` };
    // The same flow takes EDI and API orders; say where this one came from.
    if (channel !== 'email')
      return { summary: `${ORDER_CHANNEL_LABELS[channel]}${externalId ? ` · ${externalId}` : ''}` };
    return { summary: 'Email received' };
  },

  'commerce.validate': async ({ env, ctx }) => {
    const skus = ctx.order.lines.map((l) => l.sku);
    const [products, customer] = await Promise.all([
      cx.getProducts(env, skus),
      cx.getCustomer(env, ctx.order.customerId),
    ]);
    const known = new Map(products.map((p) => [p.sku, p]));
    const unknown = skus.filter((s) => !known.has(s));
    if (!ctx.order.lines.length) throw new NonRetryableError('Order has no lines');
    if (unknown.length) throw new NonRetryableError(`Unknown SKUs: ${unknown.join(', ')}`);
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
    // Buy-side models price at cost and sell-side models run the pricing chain, unless the node says otherwise.
    const buying =
      config.basis === 'cost' || (config.basis === 'auto' && isBuySide(ctx.order.model));
    // Independent reads, all at once.
    const [rows, fx, chain] = await Promise.all([
      cx.getProducts(
        env,
        ctx.order.lines.map((l) => l.sku),
      ),
      // Base-currency prices convert at the order's rate, fixed here for the life of the order.
      cx.fxRate(env, ctx.order.currency),
      buying ? null : cx.pricingFor(env, ctx.order.customerId),
    ]);
    const products = new Map(rows.map((p) => [p.sku, p]));
    if (fx === null) throw new NonRetryableError(`No exchange rate for ${ctx.order.currency}`);
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
    const t = computeTotals({ ...ctx.order, lines, fxRate: fx });
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

  'commerce.discount': async ({ env, ctx, config, stepKey, dryRun }) => {
    const codes = promoCodesOf(ctx.order.meta);
    if (!codes.length)
      return { output: { applied: [], refused: [] }, summary: 'No promotion codes' };
    const found = await cx.promotionsByCode(env, codes);
    // In the order the codes were given, so where a refusal sits says nothing about which exist.
    const refused: { code: string; reason: string }[] = [];
    const usable: Promotion[] = [];
    for (const code of codes) {
      const p = found.find((f) => f.code === code);
      if (!p) {
        refused.push({ code, reason: unknownPromotion(code) });
        continue;
      }
      const redeemed = await cx.redemptionsOf(env, p.id, ctx.order.id, ctx.order.customerId);
      const why = promotionProblem(p, {
        now: ctx.now,
        customerId: ctx.order.customerId,
        currency: ctx.order.currency,
        fxRate: ctx.order.fxRate,
        lines: ctx.order.lines,
        redeemed,
      });
      if (why) refused.push({ code: p.code, reason: why });
      else usable.push(p);
    }
    const chosen = choosePromotions(usable, ctx.order.lines, {
      fxRate: ctx.order.fxRate,
      shipping: ctx.order.shipping ?? 0,
      stack: config.stack === true,
    });
    for (const p of usable)
      if (!chosen.includes(p))
        refused.push({ code: p.code, reason: `${p.code} isn't combined with another code.` });
    let lines = ctx.order.lines;
    let shipping = ctx.order.shipping;
    const applied: AppliedPromotion[] = [];
    for (const p of chosen) {
      const r = applyPromotion(p, lines, { fxRate: ctx.order.fxRate });
      const amount = p.kind === 'free_shipping' ? (shipping ?? 0) : r.amount;
      // The redemption is the order's once it holds it; a code used up meanwhile is refused.
      const held =
        dryRun ||
        (await cx.redeemPromotion(env, {
          promotion: p,
          orderId: ctx.order.id,
          customerId: ctx.order.customerId,
          amount,
          stepKey,
        }));
      if (!held) {
        refused.push({ code: p.code, reason: `${p.code} has been used up.` });
        continue;
      }
      lines = r.lines;
      if (p.kind === 'free_shipping') shipping = 0;
      applied.push({ id: p.id, code: p.code, kind: p.kind, amount });
    }
    const t = computeTotals({ ...ctx.order, lines, shipping });
    const off = applied.reduce((s, a) => s + a.amount, 0);
    return {
      order: { lines, ...t },
      output: { applied, refused },
      vars: { promotionsRefused: refused.map((r) => r.reason) },
      summary: applied.length
        ? `${applied.map((a) => a.code).join(', ')} · ${cash(off, ctx)} off`
        : refused.length
          ? refused.map((r) => r.reason).join(' ')
          : 'No promotion codes',
    };
  },

  'commerce.shipping_rate': async ({ env, ctx, config, node, stepKey }) => {
    const rates = shippingConfigSchema.safeParse(config.rates);
    if (!rates.success)
      throw new NonRetryableError(`Invalid shipping rates: ${rates.error.issues[0]?.message}`);
    const method = ctx.order.fulfillment?.method ?? 'ship';
    const lines = method === 'ship' ? await cx.physicalLines(env, ctx.order) : [];
    const units = lines.reduce((n, l) => n + l.qty, 0);
    if (!units) {
      const t = computeTotals({ ...ctx.order, shipping: 0 });
      return {
        branches: ['ok'],
        order: t,
        output: { method, shipping: 0, option: null },
        summary:
          method === 'ship'
            ? 'Nothing to ship'
            : `No shipping (${FULFILLMENT_METHOD_LABELS[method].toLowerCase()})`,
      };
    }
    const fx = ctx.order.fxRate;
    const country = shipToCountry(ctx.order);
    // Weighed only when the basis asks; a unit whose product has no weight or size counts
    // `defaultKg`, and the output says how many did.
    const weighed = billableKg(rates.data, lines);
    const req = {
      itemCount: units,
      ...(weighed ? { billableKg: weighed.kg } : {}),
      country,
      subtotal: toBase(ctx.order.subtotal, fx),
    };
    const weight = weighed
      ? { basis: rates.data.basis, billableKg: weighed.kg, estimatedUnits: weighed.estimated }
      : {};
    const by = providerOf(config);
    const { options, source, providerError } = await cx.quoteShipping(
      env,
      rates.data,
      req,
      by
        ? {
            id: by,
            quote: () =>
              provide(env, by, {
                surface: 'shipping.rates',
                op: 'quote',
                nodeId: node.id,
                stepKey,
                orderId: ctx.order.id,
                config,
                order: ctx.order,
                input: { ...req, currency: BASE_CURRENCY },
              }),
          }
        : undefined,
    );
    // Rates are in the base currency; the order pays in its own.
    const offered = options.map((o) => ({ ...o, amount: fromBase(o.amount, fx) }));
    const select = (SHIPPING_SELECTIONS as readonly string[]).includes(str(config.select))
      ? (config.select as ShippingSelection)
      : 'from_order';
    const wanted = ctx.order.shippingOption;
    const chosen = pickOption(offered, select, wanted);
    // A provider that failed is named in the output and summary, not only in the logs.
    const fellBack = by && providerError ? { providerError: `${by}: ${providerError}` } : {};
    const note = by && providerError ? ` (${by} unavailable)` : '';
    if (!chosen)
      return {
        branches: ['unavailable'],
        output: {
          country: country ?? null,
          units,
          ...weight,
          source,
          options: offered,
          wanted: wanted ?? null,
          ...fellBack,
        },
        summary: `${wanted && offered.length ? `“${wanted}” is not offered` : 'No shipping options'}${note}`,
      };
    const t = computeTotals({ ...ctx.order, shipping: chosen.amount });
    return {
      branches: ['ok'],
      order: { ...t, shippingOption: chosen.id },
      output: {
        country: country ?? null,
        units,
        ...weight,
        source,
        option: chosen,
        options: offered,
        ...fellBack,
      },
      vars: { shippingCarrier: chosen.carrier },
      summary: `${chosen.title} (${chosen.carrier.toUpperCase()}) · ${chosen.free ? 'free' : cash(chosen.amount, ctx)}${note}`,
    };
  },

  'commerce.tax': async ({ env, ctx, config, node, stepKey }) => {
    const taxShipping = config.includeShipping !== false;
    const by = providerOf(config);
    const regions = taxRegionsSchema.safeParse(config.regions ?? []);
    const shipTo = checkAddress(ctx.order.meta?.shipTo).address;
    let rate = regionalTaxRate(
      regions.success ? regions.data : [],
      shipToCountry(ctx.order),
      shipTo?.region,
      num(config.rate, 0.08),
    );
    if (by) {
      // What computeTotals will tax: the lines' subtotal and rounded shipping, not stored totals.
      const { subtotal, shipping } = computeTotals({ ...ctx.order, taxRate: 0 });
      const { amount } = await provide(env, by, {
        surface: 'tax',
        op: 'calculate',
        nodeId: node.id,
        stepKey,
        orderId: ctx.order.id,
        config,
        order: ctx.order,
        input: { subtotal, shipping, includeShipping: taxShipping, currency: ctx.order.currency },
      });
      // Kept as the rate it works out to, so later nodes that recompute totals keep the same tax.
      const taxable = subtotal + (taxShipping ? shipping : 0);
      if (amount > 0 && taxable <= 0)
        throw new NonRetryableError(`Tax provider “${by}” charged tax on nothing taxable`);
      if (amount > taxable * PROVIDER_MAX_TAX_RATE)
        throw new NonRetryableError(
          `Tax provider “${by}” charged ${cash(amount, ctx)}, over ${PROVIDER_MAX_TAX_RATE * 100}% of ${cash(taxable, ctx)} taxable`,
        );
      rate = taxable > 0 ? amount / taxable : 0;
    }
    const t = computeTotals({ ...ctx.order, taxRate: rate, taxShipping });
    return {
      order: { ...t, taxRate: rate, taxShipping },
      output: { rate, taxShipping, ...t, ...(by ? { provider: by } : {}) },
      summary: `Tax ${cash(t.tax, ctx)} · total ${cash(t.total, ctx)}${by ? ` (${by})` : ''}`,
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
    const purpose = config.purpose === 'verify' ? 'verify' : 'hold';
    const method = str(config.method, 'card');
    const r = await cx.authorizePayment(env, ctx.order, stepKey, method, purpose);
    const ok = r.status === 'authorized' || r.status === 'verified';
    return {
      branches: [ok ? 'ok' : 'declined'],
      output: r,
      summary: !ok
        ? `Declined${r.reason ? `: ${r.reason}` : ''}`
        : r.status === 'verified'
          ? 'Verified and saved the card'
          : `Authorized ${cash(r.amount, ctx)}`,
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
    const days = billing.TERM_DAYS[terms] ?? 30;
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
    // Issued before the account is charged, so a step that fails here leaves no charge behind.
    const issued =
      config.provider === 'stripe'
        ? await billing.issueStripeInvoice(env, ctx.order, stepKey, {
            terms,
            sendEmail: config.sendEmail !== false,
            onAccount: owed,
          })
        : null;
    if (owed)
      await cx.addToBalance(env, {
        orderId: ctx.order.id,
        stepKey,
        customerId: customer.id,
        amount: toBase(ctx.order.total, ctx.order.fxRate),
      });
    const stripe = issued
      ? {
          invoiceId: issued.externalId,
          number: issued.number,
          hostedUrl: issued.hostedUrl,
          status: issued.status,
        }
      : undefined;
    return {
      output: { key, terms, due, onAccount: owed, ...(stripe ? { stripe } : {}) },
      vars: {
        invoiceKey: key,
        dueDate: due,
        ...(issued?.hostedUrl ? { invoiceUrl: issued.hostedUrl } : {}),
      },
      summary: `${terms} · due ${due}${owed ? ' · on account' : ''}${issued ? ` · ${issued.provider === 'stripe' ? `Stripe ${issued.number ?? issued.externalId}` : 'Stripe (mock)'}` : ''}`,
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

  'commerce.ship': async ({ env, ctx, config, node, stepKey }) => {
    // from_order books the carrier of the option a shipping-rate node charged, else UPS.
    const chosen = str(config.carrier, 'ups');
    const carrier =
      chosen === 'from_order' ? str(ctx.vars.shippingCarrier, 'ups').toLowerCase() : chosen;
    const by = providerOf(config);
    const r = await cx.createShipment(
      env,
      ctx.order,
      stepKey,
      carrier,
      by ? { id: by, nodeId: node.id, config } : undefined,
    );
    const tracking = r.shipments.map((s) => s.tracking).join(', ');
    return {
      output: r,
      vars: { tracking },
      summary:
        r.shipments.length === 1
          ? `${r.carrier.toUpperCase()} ${r.tracking}`
          : `${r.shipments.length} ${r.carrier.toUpperCase()} shipments: ${tracking}`,
    };
  },

  'commerce.return_label': async ({ env, ctx, config, node, stepKey }) => {
    const by = providerOf(config);
    const r = await cx.createReturnLabel(
      env,
      ctx.order,
      stepKey,
      str(config.carrier, 'ups'),
      by ? { id: by, nodeId: node.id, config } : undefined,
    );
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
    const r = await cx.paySupplier(env, ctx.order, stepKey);
    return { output: r, summary: `Scheduled ${cash(r.amount, ctx)}` };
  },

  'commerce.address_validate': async ({ env, ctx, config, node, stepKey }) => {
    const by = providerOf(config);
    const r = by
      ? await provide(env, by, {
          surface: 'address',
          op: 'validate',
          nodeId: node.id,
          stepKey,
          orderId: ctx.order.id,
          config,
          order: ctx.order,
          input: { address: ctx.order.meta?.shipTo ?? null },
        })
      : await cx.validateAddress(env, ctx.order.meta?.shipTo);
    return {
      branches: [r.status],
      output: r,
      vars: r.status === 'corrected' ? { suggestedAddress: r.address } : undefined,
      summary:
        r.status === 'valid'
          ? 'Address OK'
          : r.status === 'corrected'
            ? 'Suggested a corrected address'
            : r.issues.join('; ').slice(0, 300) || 'Address not usable',
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
    // A split names every source; otherwise the one store (none for central stock).
    const where = r.sources ? r.sources.map((x) => x.name).join(' and ') : (r.locationName ?? null);
    const at = (b: string) => (!where ? '' : b === 'ship' ? ` from ${where}` : ` at ${where}`);
    // Each line records where it ships from on a split; a single source clears any earlier split.
    const source = new Map(
      (r.sources ?? []).flatMap((x) => x.lines.map((i) => [i, x.locationId] as const)),
    );
    const lines = ctx.order.lines.map(({ locationId: _from, ...l }, i) => {
      const from = source.get(i);
      return from ? { ...l, locationId: from } : l;
    });
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
              lines,
            },
          }
        : {}),
      vars: { fulfillmentLocation: where },
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
      // Shipping stays as charged; tax re-applies at the rate the tax node used.
      order: { lines, ...computeTotals({ ...ctx.order, lines }) },
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
      // Each send is keyed by its seller, so they go out together.
      const sent = await Promise.all(
        sellers.map((s) =>
          cx.sendMessage(env, ctx.order.id, `${stepKey}:${s.id}`, s.email, subject, body),
        ),
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
  'ai.extract': async (i) => {
    const { env, ctx } = i;
    let text = ctx.order.documentText ?? '';
    if (!text && ctx.order.documentKey)
      text = (await (await env.DOCS.get(ctx.order.documentKey))?.text()) ?? '';
    if (!text) return { summary: 'No document; using order as given', output: { skipped: true } };
    const catalog = (await cx.getProducts(env)).map((p) => ({ sku: p.sku, name: p.name }));
    const { value, ...via } = await ai.extractOrder(env, text, catalog, aiCall(i));
    const customer = ctx.order.customerId
      ? undefined
      : value.customerName
        ? await cx.findCustomerByName(env, value.customerName)
        : undefined;
    // Held to the catalog and quantity bounds in `extractOrder`; what didn't pass is in `rejected`.
    const lines = value.lines;
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
      output: { ...value, ...via },
      vars: { poNumber: value.poNumber },
      summary: `${lineCount(lines.length)}${customer ? ` · ${customer.name}` : ''}${value.rejected?.length ? ` · ${value.rejected.length} held back` : ''} (${via.source})`,
    };
  },

  'ai.classify': async (i) => {
    const { env, ctx, config } = i;
    const labels = stringList(config.labels, ['other']);
    const { value, ...via } = await ai.classify(env, ctx.order, labels, aiCall(i));
    return {
      vars: { [str(config.into, 'category')]: value.label },
      output: { ...value, ...via },
      summary: `${value.label} (${Math.round(value.confidence * 100)}%)`,
    };
  },

  'ai.risk_score': async (i) => {
    const { env, ctx, config } = i;
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const { value, ...via } = await ai.riskScore(env, ctx.order, customer, aiCall(i));
    const threshold = num(config.threshold, 70);
    if (unchecked(via)) {
      // Scored at least at the threshold, so a condition on `risk` downstream agrees with the branch.
      const risk = Math.max(value.score, threshold);
      return {
        branches: ['high'],
        vars: { risk },
        output: { ...value, ...via, unchecked: true },
        summary: 'Risk not checked: the model was unavailable, so treated as high',
      };
    }
    const high = value.score >= threshold;
    return {
      branches: [high ? 'high' : 'low'],
      vars: { risk: value.score },
      output: { ...value, ...via },
      summary: `Risk ${Math.round(value.score)}${value.reasons[0] ? ` · ${value.reasons[0]}` : ''}`,
    };
  },

  'ai.forecast': async (i) => {
    const { env, ctx, config } = i;
    const stock = await cx.getProducts(env);
    const { value, ...via } = await ai.forecast(env, stock, num(config.horizonDays, 30), aiCall(i));
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
      output: { ...value, ...via },
      summary: lines.length
        ? `${lines.length} SKUs to reorder (${via.source})`
        : 'Stock is healthy',
    };
  },

  'ai.summarize': async (i) => {
    const { env, ctx, config } = i;
    const { value, ...via } = await ai.summarize(
      env,
      { order: ctx.order, vars: ctx.vars, completed: ctx.nodes },
      aiCall(i),
    );
    return {
      vars: { [str(config.into, 'summary')]: value.summary },
      output: { ...value, ...via },
      summary: value.summary.slice(0, 80),
    };
  },

  'ai.router': async (i) => {
    const { env, ctx, config } = i;
    const routes = stringList(config.routes, ['auto_approve', 'needs_approval']);
    const customer = await cx.getCustomer(env, ctx.order.customerId);
    const { value, ...via } = await ai.route(
      env,
      str(config.instructions, 'Decide how to handle this order.'),
      routes,
      {
        order: ctx.order,
        customer,
        vars: ctx.vars,
        completed: ctx.nodes,
      },
      aiCall(i),
    );
    if (unchecked(via)) {
      // A person looks at it if the flow has that route; otherwise the heuristic's choice stands.
      const route = routes.includes('needs_approval') ? 'needs_approval' : value.route;
      const reason =
        route === value.route
          ? value.reason
          : 'The model was unavailable, so this order goes to approval.';
      return {
        branches: [route],
        output: { route, reason, ...via, unchecked: true },
        summary: `→ ${route} (model unavailable)`,
      };
    }
    return { branches: [value.route], output: { ...value, ...via }, summary: `→ ${value.route}` };
  },

  'ai.assess': async (i) => {
    const { env, ctx, config } = i;
    const parsed = assessQuestionsSchema.safeParse(config.questions);
    if (!parsed.success) throw new NonRetryableError('Assess: the questions are not valid');
    const questions = parsed.data;
    const state = ai.modelView(
      env,
      config.state === 'order'
        ? { order: ctx.order }
        : {
            order: ctx.order,
            customer: await cx.getCustomer(env, ctx.order.customerId),
            vars: ctx.vars,
            completed: ctx.nodes,
          },
    );
    const { images, notes } = await clef.resolveImages(
      env,
      imageRefs(config.images, ctx),
      ctx.order.id,
    );
    const { value, ...via } = await clef.assess(env, { state, questions, images }, aiCall(i));
    const branchOn = str(config.branchOn).trim();
    const branch = assessBranch(value.answers[branchOn], num(config.minConfidence, 0));
    return {
      branches: [branch],
      vars: { [str(config.into, 'assessment')]: value.answers },
      output: { answers: value.answers, images: images.length, notes, usage: value.usage, ...via },
      summary: `${describeAnswers(value.answers)} (${via.source})`.slice(0, 160),
    };
  },
};

/**
 * Image references for Assess. An entry that is exactly `{{path}}` takes the value there as is (a
 * string or a list of them, e.g. `{{order.meta.photos}}`); anything else is interpolated.
 */
function imageRefs(v: unknown, ctx: RunContext): string[] {
  const out: string[] = [];
  for (const entry of stringList(v, [])) {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(entry);
    const value = whole ? getPath(ctx, whole[1]!) : interpolate(entry, ctx);
    for (const ref of Array.isArray(value) ? value : [value])
      if (typeof ref === 'string' && ref.trim()) out.push(ref.trim());
  }
  return out;
}

/** Saga compensations, registered on the step when the node type declares `rollback`. */
export const ROLLBACKS: Record<
  string,
  (env: Env, orderId: string, output: unknown, stepKey: string) => Promise<string>
> = {
  'commerce.reserve_inventory': async (env, orderId) =>
    `Released ${await cx.releaseInventory(env, orderId)} reservations`,
  'commerce.discount': async (env, orderId) => {
    const n = await cx.releaseRedemptions(env, orderId);
    return n
      ? `Gave back ${n} promotion ${n === 1 ? 'redemption' : 'redemptions'}`
      : 'No promotions to give back';
  },
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
  'commerce.ship': async (env, orderId, output, stepKey) => {
    const o = output as { shipmentId?: string; shipments?: { shipmentId: string }[] } | undefined;
    const ids = o?.shipments?.map((s) => s.shipmentId) ?? (o?.shipmentId ? [o.shipmentId] : []);
    // A provider's labels are voided there first. One it can't void stays `void_failed` (retried
    // daily) rather than failing the rollback, so the saga's earlier compensations still run.
    const { voided, failed, kept } = await cx.voidShipmentLabels(env, orderId, stepKey, ids);
    for (const id of ids) if (!kept.has(id)) await cx.cancelShipment(env, id);
    if (!ids.length) return 'No shipment to cancel';
    const restored = await cx.restoreShippedStock(env, orderId);
    return `Cancelled ${ids.join(', ')}${voided ? `, voided ${voided} labels` : ''}${failed ? `; ${failed} labels could not be voided with their provider (retried daily)` : ''}${restored ? `, restocked ${restored} lines` : ''}`;
  },
  'commerce.invoice': async (env, orderId) => {
    // Void first: an invoice Stripe reports paid keeps its account charge, which the payment settles.
    const { voided, paid } = await billing.voidInvoices(env, orderId);
    const reversed = await cx.reverseBalance(env, orderId);
    return `Voided ${voided} invoices${paid.length ? `, left paid ${paid.join(', ')}` : ''}, reversed ${reversed} account charges`;
  },
};

/** Applies TIME_SCALE so demos compress days into minutes. Never below one second. */
export function scaled(env: Env, duration: string): number {
  const scale = Math.max(1, Number(env.TIME_SCALE) || 1);
  return Math.max(1000, Math.round(durationMs(duration) / scale));
}
