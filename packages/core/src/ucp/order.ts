/**
 * The order capability (`dev.ucp.shopping.order`): an OrderLoop order as UCP's order entity, a
 * full snapshot every time (Get Order and every webhook). Line items keep the ids the checkout gave
 * them; shipments become fulfillment events; refunds and an order that ended without fulfilling
 * become adjustments, with negative amounts.
 */

import type { ShipAddress } from '../address';
import type { CheckoutLine } from '../checkout';
import { toMinor } from '../money';
import type { Order, OrderStatus } from '../types';
import { UCP_VERSION } from './errors';
import { ORDER_CAPABILITY, responseCapabilities, type UcpCapability } from './profile';

export type OrderShipment = {
  id: string;
  carrier: string;
  tracking: string;
  /** `label_created`, `ready_for_pickup`, `collected`, `return_label` or `cancelled`. */
  status: string;
  createdAt: number;
};

export type OrderRefund = { id: string; amount: number; status: string; createdAt: number };

export type OrderFacts = {
  order: Order;
  status: OrderStatus;
  checkoutId: string;
  /** The checkout's lines, for their ids. */
  checkoutLines: CheckoutLine[];
  /** SKUs that are physical goods. */
  physical: Set<string>;
  shipTo: Partial<ShipAddress> | null;
  shipments: OrderShipment[];
  refunds: OrderRefund[];
  /** When the order ended, for an adjustment if it ended unfulfilled. */
  updatedAt: number;
  permalink: string;
};

/** Order statuses that end it without the goods: every line is removed. */
const UNFULFILLED: readonly OrderStatus[] = ['cancelled', 'declined', 'failed', 'rolled_back'];

const iso = (ms: number) => new Date(ms).toISOString();

const SHIPMENT_EVENTS: Record<string, string> = {
  label_created: 'shipped',
  ready_for_pickup: 'ready_for_pickup',
  collected: 'delivered',
};

function postal(a: Partial<ShipAddress> | null) {
  if (!a) return {};
  return {
    ...(a.line1 ? { street_address: a.line1 } : {}),
    ...(a.line2 ? { extended_address: a.line2 } : {}),
    ...(a.city ? { address_locality: a.city } : {}),
    ...(a.region ? { address_region: a.region } : {}),
    ...(a.postalCode ? { postal_code: a.postalCode } : {}),
    ...(a.country ? { address_country: a.country } : {}),
  };
}

export function toUcpOrder(f: OrderFacts, capabilities: Map<UcpCapability, string>) {
  const { order } = f;
  const m = (n: number) => toMinor(n, order.currency);
  const removed = UNFULFILLED.includes(f.status);
  const shipped = f.shipments.filter((s) => s.status in SHIPMENT_EVENTS);
  const lines = order.lines.map((l, i) => {
    const from = f.checkoutLines[i];
    const id = from && from.sku === l.sku ? from.id : `li_${i + 1}`;
    const physical = f.physical.has(l.sku);
    // Physical goods count as fulfilled once shipped or collected; digital ones once the order is done.
    const done = physical
      ? shipped.some((s) => s.status !== 'ready_for_pickup')
      : f.status === 'completed';
    return { id, line: l, physical, done };
  });

  const line_items = lines.map(({ id, line, done }) => {
    const price = m(line.unitPrice ?? 0);
    const total = removed ? 0 : line.qty;
    const fulfilled = removed ? 0 : done ? line.qty : 0;
    return {
      id,
      item: { id: line.sku, title: line.name ?? line.sku, price },
      quantity: { original: line.qty, total, fulfilled },
      totals: [
        { type: 'subtotal', amount: price * line.qty },
        { type: 'total', amount: price * line.qty },
      ],
      status:
        total === 0
          ? 'removed'
          : fulfilled >= total
            ? 'fulfilled'
            : fulfilled > 0
              ? 'partial'
              : 'processing',
    };
  });

  const physical = lines.filter((l) => l.physical);
  const digital = lines.filter((l) => !l.physical);
  const ref = (ls: typeof lines) => ls.map((l) => ({ id: l.id, quantity: l.line.qty }));
  const pickup = order.fulfillment?.method === 'pickup';
  const expectations = [
    ...(physical.length
      ? [
          {
            id: 'exp_physical',
            line_items: ref(physical),
            method_type: pickup ? 'pickup' : 'shipping',
            destination: postal(f.shipTo),
          },
        ]
      : []),
    ...(digital.length
      ? [{ id: 'exp_digital', line_items: ref(digital), method_type: 'digital', destination: {} }]
      : []),
  ];
  const events = physical.length
    ? shipped.map((s) => ({
        id: s.id,
        occurred_at: iso(s.createdAt),
        type: SHIPMENT_EVENTS[s.status]!,
        line_items: ref(physical),
        tracking_number: s.tracking,
        carrier: s.carrier,
      }))
    : [];

  const adjustments = [
    ...f.refunds.map((r) => ({
      id: r.id,
      type: 'refund',
      occurred_at: iso(r.createdAt),
      status: r.status === 'succeeded' ? 'completed' : r.status === 'failed' ? 'failed' : 'pending',
      totals: [{ type: 'total', amount: -m(r.amount) }],
    })),
    ...(removed
      ? [
          {
            id: `adj_${f.status}`,
            type: 'cancellation',
            occurred_at: iso(f.updatedAt),
            status: 'completed',
            line_items: lines.map((l) => ({ id: l.id, quantity: -l.line.qty })),
          },
        ]
      : []),
  ];

  return {
    ucp: {
      version: UCP_VERSION,
      status: 'success' as const,
      capabilities: responseCapabilities(capabilities, ORDER_CAPABILITY),
    },
    id: order.id,
    checkout_id: f.checkoutId,
    permalink_url: f.permalink,
    currency: order.currency,
    line_items,
    fulfillment: { expectations, events },
    ...(adjustments.length ? { adjustments } : {}),
    totals: [
      { type: 'subtotal', display_text: 'Subtotal', amount: m(order.subtotal) },
      ...(order.shipping
        ? [{ type: 'fulfillment', display_text: 'Shipping', amount: m(order.shipping) }]
        : []),
      { type: 'tax', display_text: 'Tax', amount: m(order.tax) },
      { type: 'total', display_text: 'Total', amount: m(order.total) },
    ],
  };
}
