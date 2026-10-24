/**
 * Prices a checkout session with the checkout flow's own pricing nodes (validate, price, shipping
 * rate, tax and its store policy: `quoteNodes`), run in process on a draft of the order the session
 * would start; a policy the session breaks is an error the agent can fix. The
 * order the flow later runs prices the same lines the same way, so the PaymentIntent authorized at
 * completion matches the total its authorize node adopts. Nothing here writes: those executors
 * only read the catalog, prices, exchange rates and shipping rates.
 */

import { NonRetryableError } from 'cloudflare:workflows';
import {
  BASE_CURRENCY,
  type CheckoutIssue,
  type CheckoutQuote,
  type CheckoutSession,
  checkAddress,
  type FlowVersion,
  type Order,
  quoteNodes,
  type RunContext,
  type ShippingOption,
  withDefaults,
} from '@orderloop/core';
import { getProducts } from '../connectors';
import { EXECUTORS } from '../nodes';
import { providerOfError } from '../providers';

export type Quoted = { quote: CheckoutQuote | null; issues: CheckoutIssue[] };

const issue = (code: string, content: string, path: string): CheckoutIssue => ({
  kind: 'error',
  code,
  content,
  path,
  severity: 'recoverable',
});

/** The order a session would start, before any node has priced it. */
export function draftOrder(flow: FlowVersion, s: CheckoutSession, ships: boolean): Order {
  const name = [s.buyer.firstName, s.buyer.lastName].filter(Boolean).join(' ');
  return {
    id: `quote_${s.id}`,
    model: flow.model,
    channel: 'agent',
    externalId: s.id,
    currency: s.currency,
    lines: s.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    ...(s.buyer.email
      ? {
          contact: {
            email: s.buyer.email,
            ...(name ? { name } : {}),
            ...(s.buyer.phone ? { phone: s.buyer.phone } : {}),
          },
        }
      : {}),
    fulfillment: { method: ships ? 'ship' : 'digital' },
    ...(s.shippingOption ? { shippingOption: s.shippingOption } : {}),
    meta: s.shipTo ? { shipTo: s.shipTo } : {},
    createdAt: s.createdAt,
    subtotal: 0,
    shipping: 0,
    tax: 0,
    total: 0,
  };
}

export async function quoteCheckout(
  env: Env,
  flow: FlowVersion,
  s: CheckoutSession,
): Promise<Quoted> {
  const issues: CheckoutIssue[] = [];
  const products = new Map(
    (
      await getProducts(
        env,
        s.lines.map((l) => l.sku),
      )
    ).map((p) => [p.sku, p]),
  );
  const held = new Map<string, number>();
  for (const [i, l] of s.lines.entries()) {
    const p = products.get(l.sku);
    if (!p) {
      issues.push(issue('item_unavailable', `${l.sku} is not sold here.`, `$.line_items[${i}]`));
      continue;
    }
    if (p.kind === 'digital') continue;
    const wanted = (held.get(l.sku) ?? 0) + l.qty;
    held.set(l.sku, wanted);
    if (wanted > p.stock - p.reserved)
      issues.push(
        issue(
          'out_of_stock',
          `Only ${Math.max(0, p.stock - p.reserved)} of ${p.name} are available.`,
          `$.line_items[${i}].quantity`,
        ),
      );
  }
  if (issues.some((i) => i.code === 'item_unavailable')) return { quote: null, issues };
  const ships = s.lines.some((l) => products.get(l.sku)?.kind !== 'digital');
  if (ships && s.shipTo && checkAddress(s.shipTo).status === 'invalid')
    issues.push(
      issue(
        'address_undeliverable',
        'The shipping address is incomplete or not valid.',
        '$.fulfillment',
      ),
    );

  const ctx: RunContext = {
    order: draftOrder(flow, s, ships),
    nodes: {},
    vars: {},
    input: {},
    now: Date.now(),
    ref: s.id,
  };
  let options: ShippingOption[] = [];
  let chosen: string | null = null;
  for (const node of quoteNodes(flow)) {
    const exec = EXECUTORS[node.type];
    if (!exec) continue;
    try {
      const r = await exec({
        env,
        node,
        config: withDefaults(node.type, node.config),
        ctx,
        stepKey: `quote#${node.id}`,
      });
      if (r.order) ctx.order = { ...ctx.order, ...r.order };
      if (node.type === 'commerce.policy' && r.branches?.includes('fail'))
        for (const failure of (r.vars?.policyFailures as string[] | undefined) ?? [])
          issues.push(issue('policy', failure, '$'));
      if (node.type === 'commerce.shipping_rate') {
        const out = (r.output ?? {}) as {
          options?: ShippingOption[];
          option?: ShippingOption | null;
        };
        options = out.options ?? [];
        chosen = out.option?.id ?? null;
        if (r.branches?.includes('unavailable'))
          issues.push(
            issue(
              s.shippingOption && options.length
                ? 'fulfillment_option_unavailable'
                : 'address_undeliverable',
              s.shippingOption && options.length
                ? `The shipping option “${s.shippingOption}” is not offered.`
                : 'Nothing ships to this address.',
              '$.fulfillment',
            ),
          );
      }
    } catch (err) {
      // A provider's failure (retryable or not) is an issue the platform can retry on, with a
      // fixed message: a provider's own text never reaches the buyer's agent.
      if (providerOfError(err)) {
        console.warn(`pricing checkout ${s.id}: provider ${providerOfError(err)}`, err);
        issues.push(issue('invalid', 'Shipping or tax could not be calculated right now.', '$'));
        return { quote: null, issues };
      }
      if (!(err instanceof NonRetryableError)) throw err;
      issues.push(issue('invalid', err.message, '$'));
      return { quote: null, issues };
    }
  }
  const o = ctx.order;
  return {
    quote: {
      currency: o.currency || BASE_CURRENCY,
      lines: o.lines.map((l, i) => ({
        id: s.lines[i]!.id,
        sku: l.sku,
        title: l.name ?? products.get(l.sku)?.name ?? l.sku,
        qty: l.qty,
        unitPrice: l.unitPrice ?? 0,
        ships: products.get(l.sku)?.kind !== 'digital',
      })),
      subtotal: o.subtotal,
      shipping: o.shipping ?? 0,
      tax: o.tax,
      total: o.total,
      shippingOptions: options,
      shippingOption: chosen,
      ships,
    },
    issues,
  };
}
