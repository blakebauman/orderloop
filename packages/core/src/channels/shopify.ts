/**
 * Shopify `orders/create` webhooks as inbound orders. Pure: the web app verifies the HMAC with
 * `verifyShopifyHmac`, looks the customer up by email and starts what `shopifyToInbound` returns.
 * Prices come from Shopify and are kept by the price node; SKUs are used as Shopify has them.
 */

import type { InboundOrder } from '../inbound';
import { CUSTOMER_MATCHED_BY } from '../tax-exemption';
import type { OrderChannel } from '../types';
import { constantTimeEqual } from '../webhooks';

/** The fields OrderLoop reads from Shopify's order payload. */
export type ShopifyOrder = {
  id: number | string;
  name?: string;
  email?: string | null;
  currency: string;
  source_name?: string | null;
  company?: unknown;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  } | null;
  line_items: {
    sku?: string | null;
    title: string;
    quantity: number;
    price: string;
  }[];
  shipping_address?: {
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province_code?: string | null;
    zip?: string | null;
    country_code?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
};

export type ChannelResult = { ok: true; order: InboundOrder } | { ok: false; error: string };

const CHANNEL_BY_SOURCE: Record<string, OrderChannel> = {
  pos: 'pos',
  iphone: 'mobile',
  android: 'mobile',
};

export function shopifyToInbound(
  order: ShopifyOrder,
  opts: { customerId?: string } = {},
): ChannelResult {
  if (order?.id === undefined || order.id === null || !Array.isArray(order.line_items))
    return { ok: false, error: 'Not a Shopify order: missing id or line_items' };
  const missing = order.line_items.filter((l) => !l.sku?.trim()).map((l) => l.title);
  if (missing.length)
    return { ok: false, error: `Line items without a SKU: ${missing.join(', ')}` };
  const lines = order.line_items.map((l) => ({
    sku: l.sku!.trim(),
    name: l.title,
    qty: l.quantity,
    unitPrice: Number(l.price),
  }));
  if (lines.some((l) => !(l.qty > 0) || !Number.isFinite(l.unitPrice)))
    return { ok: false, error: 'Every line item needs a positive quantity and a price' };

  const a = order.shipping_address;
  const shipTo =
    a?.address1 && a.city && a.zip && a.country_code
      ? {
          ...(a.name ? { name: a.name } : {}),
          line1: a.address1,
          ...(a.address2 ? { line2: a.address2 } : {}),
          city: a.city,
          ...(a.province_code ? { region: a.province_code } : {}),
          postalCode: a.zip,
          country: a.country_code,
          ...(typeof a.latitude === 'number' && typeof a.longitude === 'number'
            ? { latitude: a.latitude, longitude: a.longitude }
            : {}),
        }
      : undefined;
  const name = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ');

  return {
    ok: true,
    order: {
      model: order.company ? 'b2b' : 'b2c',
      channel: CHANNEL_BY_SOURCE[order.source_name ?? ''] ?? 'web',
      externalId: String(order.id),
      source: 'shopify',
      title: order.name ? `Shopify order ${order.name}` : undefined,
      currency: order.currency,
      lines,
      ...(opts.customerId ? { customerId: opts.customerId } : {}),
      ...(order.email ? { contact: { email: order.email, ...(name ? { name } : {}) } } : {}),
      ...(shipTo ? { shipTo } : {}),
      // Shopify took the money at checkout: authorize and capture only record it.
      payment: { provider: 'external', reference: String(order.id) },
      meta: {
        shopify: { id: order.id, name: order.name ?? null },
        // Matched by the buyer's email, which anyone can type: no exemptions (`customerTrusted`).
        ...(opts.customerId ? { [CUSTOMER_MATCHED_BY]: 'email' } : {}),
      },
    },
  };
}

/**
 * Shopify signs each webhook with the app's client secret: `X-Shopify-Hmac-Sha256` is the base64
 * HMAC-SHA256 of the raw body. Compared in constant time.
 */
export async function verifyShopifyHmac(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)),
  );
  const expected = btoa(String.fromCharCode(...mac));
  return constantTimeEqual(expected, header);
}
