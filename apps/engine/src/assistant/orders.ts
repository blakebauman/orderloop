/**
 * Starting orders through the assistant: a new order on a published flow, a restart of an old one,
 * and a demo scenario. Each is an action: the card states the flow, lines, buyer and fulfilment,
 * checked against the workspace (published flow, known SKUs, customer, store, currency), and the
 * same checks run again when the person confirms. An order runs its flow for real, payments and
 * shipping included, so nothing here starts without a confirm.
 *
 * Starts are keyed (`startOrderOnce`) by the confirm they came from, so an answer retried after
 * the object restarted mid-run finds the order it already started instead of starting another.
 */

import {
  type ActionPreview,
  BASE_CURRENCY,
  boundText,
  FULFILLMENT_METHOD_LABELS,
  type FulfillmentMethod,
  type OrderChannel,
  type OrderInput,
  type OrderModel,
  type Principal,
  SCENARIO_CUSTOMERS,
  SCENARIO_SKUS,
  SCENARIOS,
} from '@orderloop/core';
import { createDb, customers, flows, fxRates, locations, products } from '@orderloop/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { recordAudit } from '../audit';
import { ensureTemplates } from '../flows';
import { startOrderOnce } from '../orders';
import { orderRef, Refused, snapshot } from './data';

/** Pickup and carry-out happen at a store, so they need one. */
const AT_STORE: FulfillmentMethod[] = ['pickup', 'carry_out'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export type StartInput = {
  flowId: string;
  title?: string;
  channel?: OrderChannel;
  customerId?: string;
  contact?: { email: string; name?: string };
  fulfillment?: { method: FulfillmentMethod; locationId?: string };
  currency?: string;
  lines: { sku: string; qty: number }[];
  documentText?: string;
};

/** The flow, if it is published: orders run only on a published version. */
async function publishedFlow(env: Env, flowId: string) {
  const row = await createDb(env.DB)
    .select({ id: flows.id, name: flows.name, model: flows.model, version: flows.publishedVersion })
    .from(flows)
    .where(eq(flows.id, flowId))
    .get();
  return row?.version ? row : null;
}

/** What is wrong with a new order, in the words the form used; null when it can start. */
async function startProblem(env: Env, i: StartInput): Promise<string | null> {
  const db = createDb(env.DB);
  if (!(await publishedFlow(env, i.flowId)))
    return 'Pick a published flow. Flows must be published before orders can run on them.';
  if (!i.lines.length && !i.documentText) return 'Add at least one line.';
  if (i.customerId && i.contact) return 'Choose a customer or a guest contact, not both.';
  const skus = [...new Set(i.lines.map((l) => l.sku))];
  if (skus.length) {
    const known = new Set(
      (
        await db.select({ sku: products.sku }).from(products).where(inArray(products.sku, skus))
      ).map((r) => r.sku),
    );
    const unknown = skus.filter((s) => !known.has(s));
    if (unknown.length) return `Not in the catalog: ${unknown.slice(0, 5).join(', ')}.`;
  }
  if (
    i.customerId &&
    !(await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, i.customerId))
      .get())
  )
    return 'That customer no longer exists. Pick another.';
  const method = i.fulfillment?.method;
  if (method && AT_STORE.includes(method)) {
    const at = i.fulfillment?.locationId;
    const store = at
      ? await db.select({ kind: locations.kind }).from(locations).where(eq(locations.id, at)).get()
      : null;
    if (store?.kind !== 'store') return `${FULFILLMENT_METHOD_LABELS[method]} needs a store.`;
  }
  const currency = i.currency ?? BASE_CURRENCY;
  if (
    currency !== BASE_CURRENCY &&
    !(await db
      .select({ c: fxRates.currency })
      .from(fxRates)
      .where(eq(fxRates.currency, currency))
      .get())
  )
    return `There is no exchange rate for ${currency}.`;
  return null;
}

/** An order's input, said as card lines: what it is for, who buys, how it is fulfilled. */
async function described(env: Env, input: OrderInput): Promise<string[]> {
  const customer = input.customerId
    ? ((
        await createDb(env.DB)
          .select({ name: customers.name })
          .from(customers)
          .where(eq(customers.id, input.customerId))
          .get()
      )?.name ?? input.customerId)
    : null;
  const shown = input.lines.slice(0, 4).map((l) => `${l.sku} × ${l.qty}`);
  // Everything the order acts on is said, so a proposed start can't hide what it does. A card is
  // never stored or read by a model, so the guest's address and the document can show here.
  const doc = input.documentText ? boundText(input.documentText, 160) : null;
  return [
    input.lines.length
      ? `${plural(input.lines.length, 'line')}: ${shown.join(', ')}${input.lines.length > 4 ? ', …' : ''}`
      : 'No lines: the flow reads them from the document',
    customer
      ? `For ${boundText(customer, 80) ?? input.customerId}`
      : input.contact
        ? `For a guest buyer: ${boundText(input.contact.email, 200)}${input.contact.name ? ` (${boundText(input.contact.name, 80)})` : ''}; the flow's messages go there`
        : 'No customer',
    ...(input.title ? [`Titled “${boundText(input.title, 140)}”`] : []),
    ...(input.currency !== BASE_CURRENCY ? [`In ${input.currency}`] : []),
    ...(input.channel !== 'manual' ? [`On the ${input.channel} channel`] : []),
    ...(doc
      ? [
          `With a ${input.documentText!.length.toLocaleString('en-US')}-character document${input.lines.length ? '' : ' the lines are read from'}: “${doc}${input.documentText!.length > 160 ? '…' : ''}”`,
        ]
      : []),
    input.fulfillment
      ? `${FULFILLMENT_METHOD_LABELS[input.fulfillment.method]}${input.fulfillment.locationId ? ` from ${input.fulfillment.locationId}` : ''}`
      : 'Fulfilled as the flow decides',
    'It runs the flow as published: its payment, stock and shipping steps act for real',
  ];
}

function inputOf(i: StartInput, model: string): OrderInput {
  return {
    model: model as OrderModel,
    channel: i.channel ?? 'manual',
    title: i.title,
    customerId: i.customerId,
    contact: i.contact,
    fulfillment: i.fulfillment,
    currency: i.currency ?? BASE_CURRENCY,
    lines: i.lines,
    documentText: i.documentText,
    meta: {},
  };
}

export async function previewStart(
  env: Env,
  i: StartInput,
  roleBlock?: string,
): Promise<ActionPreview> {
  const flow = await publishedFlow(env, i.flowId);
  return {
    title: `Start an order on ${flow?.name ?? i.flowId}${flow ? ` v${flow.version}` : ''}`,
    href: `/flows/${i.flowId}`,
    consequences: flow ? await described(env, inputOf(i, flow.model)) : [],
    blocked: roleBlock ?? (await startProblem(env, i)) ?? undefined,
  };
}

export async function previewRestart(
  env: Env,
  orderId: string,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { prev, input } = await restartOf(env, orderId);
  const flow = prev.flow ? await publishedFlow(env, prev.flow.id) : null;
  return {
    title: `Restart ${orderRef(orderId)} as a new order`,
    href: `/orders/${orderId}`,
    consequences: [
      `On ${flow?.name ?? prev.flow?.id}${flow ? ` v${flow.version}, its current version` : ''}`,
      ...(await described(env, input)),
      'Demo failure switches are dropped, and this order stays as it is',
    ],
    blocked: roleBlock ?? (flow ? undefined : 'Its flow is no longer published.'),
  };
}

/** The demo data is loaded: every customer and SKU the scenarios need is in the workspace. */
async function demoLoaded(env: Env) {
  const db = createDb(env.DB);
  const [c, p] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(customers)
      .where(inArray(customers.id, SCENARIO_CUSTOMERS))
      .get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(products)
      .where(inArray(products.sku, SCENARIO_SKUS))
      .get(),
  ]);
  return c?.n === SCENARIO_CUSTOMERS.length && p?.n === SCENARIO_SKUS.length;
}

/** A fresh order like `orderId`: same buyer and lines, its flow's current version, no simulation. */
async function restartOf(env: Env, orderId: string) {
  const prev = await snapshot(env, orderId);
  if (!prev?.order || !prev.flow) throw new Refused(`No order matches ${orderId}.`);
  // Neither its demo failure switches nor the marks only the core sets (a UCP checkout, a cart, a
  // plugin): the new order is started here, not by them.
  const {
    simulate: _simulate,
    ucp: _ucp,
    cart: _cart,
    plugin: _plugin,
    ...meta
  } = prev.order.meta ?? {};
  const input: OrderInput = {
    model: prev.order.model,
    channel: prev.order.channel,
    contact: prev.order.contact,
    fulfillment: prev.order.fulfillment,
    title: prev.order.title,
    customerId: prev.order.customerId,
    currency: prev.order.currency,
    lines: prev.order.lines.map(({ sku, qty }) => ({ sku, qty })),
    documentText: prev.order.documentText,
    documentKey: prev.order.documentKey,
    meta: { ...meta, restartedFrom: orderId },
  };
  return { prev, input };
}

type Trail = Record<string, unknown>;

/** Starts once per `key`; a key already used returns the order it started. */
async function startKeyed(
  env: Env,
  p: Principal,
  flowId: string,
  input: OrderInput,
  key: string | undefined,
  trail: Trail,
) {
  const result = await startOrderOnce(env, {
    flowId,
    input,
    startedBy: p.id,
    idempotencyKey: `assistant:${p.id}:${key ?? crypto.randomUUID()}`,
  });
  if ('mismatch' in result) throw new Refused('This confirm already started a different order.');
  if (!result.replayed)
    await recordAudit(env, 'order.started', {
      actor: p,
      target: result.orderId,
      detail: { flowId, ...trail },
    });
  return {
    done: `Started ${orderRef(result.orderId)}`,
    href: `/orders/${result.orderId}`,
    orderId: result.orderId,
  };
}

export async function runStart(
  env: Env,
  p: Principal,
  i: StartInput,
  key: string | undefined,
  trail: Trail,
) {
  const flow = await publishedFlow(env, i.flowId);
  if (!flow) throw new Refused('Pick a published flow.');
  return startKeyed(env, p, i.flowId, inputOf(i, flow.model), key, trail);
}

export async function runRestart(
  env: Env,
  p: Principal,
  orderId: string,
  key: string | undefined,
  trail: Trail,
) {
  const { prev, input } = await restartOf(env, orderId);
  return startKeyed(env, p, prev.flow!.id, input, key, { ...trail, restartedFrom: orderId });
}

/** A demo scenario's order, failure switches and all, where the demo data is loaded. */
export async function startScenario(env: Env, p: Principal, id: string, trail: Trail) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s || !(await demoLoaded(env))) throw new Refused('That demo scenario isn’t available here.');
  await ensureTemplates(env);
  if (!(await publishedFlow(env, s.flowId)))
    throw new Refused('Its flow is not published. Publish it on the Flows page first.');
  return startKeyed(env, p, s.flowId, s.input, undefined, { ...trail, scenario: s.id });
}
