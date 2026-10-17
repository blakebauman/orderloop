/**
 * The checkout capability (`dev.ucp.shopping.checkout`) and its fulfillment extension, as a view of
 * the protocol-neutral session (../checkout.ts): what a platform sends becomes a `CheckoutPatch`,
 * and a session becomes the checkout object UCP responses carry. Amounts are integer minor units.
 *
 * Fulfillment is shipping only: one method covering every line that ships, one destination (the
 * ship-to, `dest_1`) and one group (`fg_1`) whose options are the checkout flow's shipping rates.
 */

import { z } from 'zod';
import type { ShipAddress } from '../address';
import type { CheckoutIssue, CheckoutPatch, CheckoutSession } from '../checkout';
import { MAX_CHECKOUT_LINES, MAX_LINE_QUANTITY } from '../checkout';
import { toMinor } from '../money';
import { UCP_VERSION, ucpMessage } from './errors';
import {
  CHECKOUT_CAPABILITY,
  FULFILLMENT_CAPABILITY,
  responseCapabilities,
  type UcpCapability,
  type UcpPaymentHandler,
  type UcpSettings,
} from './profile';

const str = (max: number) => z.string().max(max);

/** `common/types/postal_address.json`. */
const postalAddress = z
  .object({
    street_address: str(200).optional(),
    extended_address: str(200).optional(),
    address_locality: str(100).optional(),
    address_region: str(100).optional(),
    postal_code: str(20).optional(),
    address_country: str(60).optional(),
    first_name: str(100).optional(),
    last_name: str(100).optional(),
    phone_number: str(40).optional(),
  })
  .passthrough();
type PostalAddress = z.infer<typeof postalAddress>;

const lineItem = z
  .object({
    id: str(40).optional(),
    item: z.object({ id: z.string().min(1).max(100) }).passthrough(),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  })
  .passthrough();

const buyer = z
  .object({
    email: z.string().email().max(320).optional(),
    first_name: str(100).optional(),
    last_name: str(100).optional(),
    phone_number: str(40).optional(),
  })
  .passthrough();

const fulfillment = z
  .object({
    methods: z
      .array(
        z
          .object({
            id: str(40).optional(),
            type: str(40).optional(),
            destinations: z
              .array(postalAddress.extend({ id: str(40).optional(), type: str(40).optional() }))
              .max(10)
              .optional(),
            selected_destination_id: str(40).nullish(),
            groups: z
              .array(
                z
                  .object({ id: str(40).optional(), selected_option_id: str(80).nullish() })
                  .passthrough(),
              )
              .max(10)
              .optional(),
          })
          .passthrough(),
      )
      .max(5)
      .optional(),
  })
  .passthrough();

/** Create and Update Checkout (Update replaces the whole session). */
export const ucpCheckoutInput = z
  .object({
    line_items: z.array(lineItem).min(1).max(MAX_CHECKOUT_LINES),
    buyer: buyer.optional(),
    fulfillment: fulfillment.optional(),
  })
  .passthrough();
export type UcpCheckoutInput = z.infer<typeof ucpCheckoutInput>;

/** A payment instrument at Complete Checkout (`common/types/payment_instrument.json`). */
export const ucpInstrument = z
  .object({
    id: z.string().min(1).max(100),
    handler_id: z.string().min(1).max(100),
    type: z.string().min(1).max(40),
    selected: z.boolean().optional(),
    credential: z
      .object({ type: z.string().min(1).max(60), token: z.string().min(1).max(500).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type UcpInstrument = z.infer<typeof ucpInstrument>;

export const ucpCompleteInput = z
  .object({
    payment: z.object({ instruments: z.array(ucpInstrument).min(1).max(5) }).passthrough(),
  })
  .passthrough();

/** The instrument the platform chose: the one marked `selected`, else the only one. */
export function selectedInstrument(input: z.infer<typeof ucpCompleteInput>): UcpInstrument | null {
  const all = input.payment.instruments;
  return all.find((i) => i.selected) ?? (all.length === 1 ? all[0]! : null);
}

export const DESTINATION_ID = 'dest_1';
export const SHIPPING_METHOD_ID = 'fm_shipping';
export const SHIPPING_GROUP_ID = 'fg_1';

function fromPostal(a: PostalAddress): Partial<ShipAddress> {
  const name = [a.first_name, a.last_name].filter(Boolean).join(' ');
  const out: Partial<ShipAddress> = {};
  if (name) out.name = name;
  if (a.street_address) out.line1 = a.street_address;
  if (a.extended_address) out.line2 = a.extended_address;
  if (a.address_locality) out.city = a.address_locality;
  if (a.address_region) out.region = a.address_region;
  if (a.postal_code) out.postalCode = a.postal_code;
  if (a.address_country) out.country = a.address_country;
  return out;
}

function toPostal(a: Partial<ShipAddress>): PostalAddress {
  const [first, ...rest] = (a.name ?? '').split(' ').filter(Boolean);
  return {
    ...(a.line1 ? { street_address: a.line1 } : {}),
    ...(a.line2 ? { extended_address: a.line2 } : {}),
    ...(a.city ? { address_locality: a.city } : {}),
    ...(a.region ? { address_region: a.region } : {}),
    ...(a.postalCode ? { postal_code: a.postalCode } : {}),
    ...(a.country ? { address_country: a.country } : {}),
    ...(first ? { first_name: first } : {}),
    ...(rest.length ? { last_name: rest.join(' ') } : {}),
  };
}

/**
 * What a Create or Update Checkout asks for, as a patch over `current`. Update is a full
 * replacement, so whatever the request leaves out is cleared; a destination the platform names by
 * our id (`dest_1`) without resending it keeps the ship-to we hold.
 */
export function checkoutPatch(input: UcpCheckoutInput, current?: CheckoutSession): CheckoutPatch {
  const b = input.buyer;
  const shipping = input.fulfillment?.methods?.find((m) => !m.type || m.type === 'shipping');
  let shipTo: Partial<ShipAddress> | null = null;
  if (shipping) {
    const dests = shipping.destinations ?? [];
    const chosen = dests.find((d) => d.id && d.id === shipping.selected_destination_id) ?? dests[0];
    if (chosen) shipTo = fromPostal(chosen);
    else if (shipping.selected_destination_id === DESTINATION_ID) shipTo = current?.shipTo ?? null;
  }
  const option = shipping?.groups?.find((g) => g.selected_option_id)?.selected_option_id ?? null;
  return {
    lines: input.line_items.map((l) => ({ id: l.id, sku: l.item.id, qty: l.quantity })),
    buyer: {
      ...(b?.email ? { email: b.email } : {}),
      ...(b?.first_name ? { firstName: b.first_name } : {}),
      ...(b?.last_name ? { lastName: b.last_name } : {}),
      ...(b?.phone_number ? { phone: b.phone_number } : {}),
    },
    shipTo,
    shippingOption: option,
  };
}

/** Everything a checkout response needs beyond the session. */
export type CheckoutView = {
  capabilities: Map<UcpCapability, string>;
  handlers: UcpPaymentHandler[];
  settings: UcpSettings;
  /** The order's page, once completing the checkout placed one. */
  permalink?: string;
};

/** The `ucp.payment_handlers` registry a checkout response carries. */
function handlerRegistry(handlers: UcpPaymentHandler[]) {
  const out: Record<string, Omit<UcpPaymentHandler, 'name'>[]> = {};
  for (const { name, ...h } of handlers) out[name] = [...(out[name] ?? []), h];
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The checkout object for `s`, with its UCP envelope. */
export function toUcpCheckout(s: CheckoutSession, view: CheckoutView) {
  const cur = s.currency;
  const m = (n: number) => toMinor(n, cur);
  const priced = new Map((s.quote?.lines ?? []).map((l) => [l.id, l]));
  const line_items = s.lines.map((l) => {
    const p = priced.get(l.id);
    const price = m(p?.unitPrice ?? 0);
    const total = price * l.qty;
    return {
      id: l.id,
      item: { id: l.sku, title: p?.title ?? l.title ?? l.sku, price },
      quantity: l.qty,
      totals: [
        { type: 'subtotal', amount: total },
        { type: 'total', amount: total },
      ],
    };
  });
  const q = s.quote;
  const totals = [
    { type: 'subtotal', display_text: 'Subtotal', amount: m(q?.subtotal ?? 0) },
    ...(q?.ships ? [{ type: 'fulfillment', display_text: 'Shipping', amount: m(q.shipping) }] : []),
    { type: 'tax', display_text: 'Tax', amount: m(q?.tax ?? 0) },
    { type: 'total', display_text: 'Total', amount: m(q?.total ?? 0) },
  ];

  const fulfills = view.capabilities.has(FULFILLMENT_CAPABILITY) && q?.ships;
  const shippedIds = (q?.lines ?? []).filter((l) => l.ships).map((l) => l.id);
  const selected = s.shippingOption ?? q?.shippingOption ?? null;
  const fulfillmentView = fulfills
    ? {
        methods: [
          {
            id: SHIPPING_METHOD_ID,
            type: 'shipping',
            line_item_ids: shippedIds,
            destinations: s.shipTo
              ? [{ id: DESTINATION_ID, type: 'shipping_address', ...toPostal(s.shipTo) }]
              : [],
            selected_destination_id: s.shipTo ? DESTINATION_ID : null,
            groups: [
              {
                id: SHIPPING_GROUP_ID,
                line_item_ids: shippedIds,
                options: q.shippingOptions.map((o) => ({
                  id: o.id,
                  title: o.title,
                  carrier: o.carrier,
                  totals: [{ type: 'total', amount: m(o.amount) }],
                })),
                selected_option_id: q.shippingOptions.some((o) => o.id === selected)
                  ? selected
                  : null,
              },
            ],
          },
        ],
        available_methods: [{ type: 'shipping', line_item_ids: shippedIds }],
      }
    : undefined;

  const done = s.status === 'completed' || s.status === 'canceled';
  return {
    ucp: {
      version: UCP_VERSION,
      status: 'success' as const,
      capabilities: responseCapabilities(view.capabilities, CHECKOUT_CAPABILITY),
      payment_handlers: done ? {} : handlerRegistry(view.handlers),
    },
    id: s.id,
    status: s.status,
    currency: cur,
    line_items,
    ...(Object.keys(s.buyer).length
      ? {
          buyer: {
            ...(s.buyer.email ? { email: s.buyer.email } : {}),
            ...(s.buyer.firstName ? { first_name: s.buyer.firstName } : {}),
            ...(s.buyer.lastName ? { last_name: s.buyer.lastName } : {}),
            ...(s.buyer.phone ? { phone_number: s.buyer.phone } : {}),
          },
        }
      : {}),
    totals,
    links: view.settings.links,
    ...(s.issues.length ? { messages: s.issues.map(ucpMessage) } : {}),
    ...(done ? {} : { expires_at: iso(s.expiresAt) }),
    ...(fulfillmentView ? { fulfillment: fulfillmentView } : {}),
    ...(s.orderId && view.permalink
      ? { order: { id: s.orderId, permalink_url: view.permalink } }
      : {}),
  };
}

/** Issues only UCP raises: goods that ship when the platform can't send an address. */
export function protocolIssues(
  s: CheckoutSession,
  capabilities: Map<UcpCapability, string>,
): CheckoutIssue[] {
  if (s.quote?.ships && !capabilities.has(FULFILLMENT_CAPABILITY))
    return [
      {
        kind: 'error',
        code: 'fulfillment_required',
        content: `These items ship; the platform must support ${FULFILLMENT_CAPABILITY} to send an address.`,
        path: '$.line_items',
        severity: 'unrecoverable',
      },
    ];
  return [];
}
