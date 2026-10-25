/**
 * What a plugin can ask of the core, through the `ORDERLOOP` binding the engine gives it
 * (`PluginHostRpc`, served by the engine's `PluginHost` entrypoint). Each method needs a capability
 * the plugin's manifest declares and the deployment grants (`PLUGIN_CAPABILITIES`). Who is calling
 * comes from the binding itself (its props), never from an argument, so a plugin acts only as
 * itself: it reads only the carts it opened, and its order keys are namespaced by its id.
 */

import type { Cart } from './cart';
import { MAX_CHECKOUT_LINES, MAX_LINE_QUANTITY } from './checkout';
import type { OrderInputDraft } from './types';

/** How long an external cart may stay open, at most. */
export const MAX_EXTERNAL_CART_MS = 24 * 3_600_000;
/** How long a start link works, once. */
export const CART_START_TTL_MS = 5 * 60_000;
/** Origins that may frame an external cart's pages (the buyer's procurement system). */
export const MAX_FRAME_ORIGINS = 10;
/** Form fields a cart's return may carry, and their size in all. */
export const MAX_RETURN_FIELDS = 2_000;
export const MAX_RETURN_BYTES = 1024 * 1024;

export type ExternalCartInput = {
  /** The plugin's own id for the session; opening the same one again finds the same cart. */
  sessionRef: string;
  title: string;
  flowId: string;
  customerId?: string | null;
  /** The buyer, as the plugin authenticated them; shown to everyone on the cart. */
  buyer: { id: string; name: string };
  /** Where the cart goes back to (an https URL the plugin has checked is its partner's). */
  returnUrl: string;
  /** Origins that may frame the cart's pages; https only. */
  frameOrigins?: string[];
  /** When the cart closes if it hasn't gone back, at most `MAX_EXTERNAL_CART_MS` from now. */
  expiresAt: number;
  /** Lines to start with (a punchout `edit` session, say). */
  lines?: { sku: string; qty: number }[];
};

export type ExternalCartOpened = {
  cartId: string;
  /** The path (on the app's origin) that admits the buyer, once, within `CART_START_TTL_MS`. */
  startPath: string;
  /** The same on the app's origin, where the deployment knows it (`APP_ORIGIN`). */
  startUrl: string | null;
};

/** What a plugin sees of a cart it opened. */
export type PluginCart = Pick<
  Cart,
  'id' | 'title' | 'status' | 'customerId' | 'lines' | 'quote' | 'orderId' | 'updatedAt'
> & { sessionRef: string };

export type CartReturnRequest = { cart: PluginCart };

/** Form fields posted to the cart's `returnUrl` (`application/x-www-form-urlencoded`). */
export type CartReturn = { fields: Record<string, string> };

export type PluginStartOrder = {
  /** Unique per order for this plugin (a PO's payload id, say); the order starts once per key. */
  key: string;
  flowId: string;
  input: OrderInputDraft;
};

export interface PluginHostRpc {
  openExternalCart(
    input: ExternalCartInput,
  ): Promise<{ ok: true; cart: ExternalCartOpened } | { ok: false; error: string }>;
  getCart(cartId: string): Promise<PluginCart | null>;
  startOrder(
    req: PluginStartOrder,
  ): Promise<{ ok: true; orderId: string; replayed: boolean } | { ok: false; error: string }>;
  /**
   * Cancels an order this plugin started, by the key it started it under (`orders:start`):
   * `cancelled` (also when it already was, or a cancel is already under way), `finished` when it
   * ended some other way and can't be, or not found for a key this plugin never started an order
   * under.
   */
  cancelOrder(req: {
    key: string;
    reason: string;
  }): Promise<
    { ok: true; orderId: string; outcome: 'cancelled' | 'finished' } | { ok: false; error: string }
  >;
}

const httpsUrl = (raw: string): URL | null => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
};

/** Why `input` can't open a cart, or null. The engine checks the flow and customer itself. */
export function externalCartProblem(
  input: ExternalCartInput,
  now: number,
  /** Hosts the deployment serves (its app, catalog): a cart never posts back to them. */
  ownHosts: readonly string[] = [],
): string | null {
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!str(input?.sessionRef, 200)) return 'sessionRef is 1 to 200 characters';
  if (!str(input.title, 200) || !str(input.flowId, 100)) return 'title and flowId are strings';
  if (input.customerId != null && !str(input.customerId, 100)) return 'customerId is a string';
  if (!str(input.buyer?.id, 200) || !str(input.buyer?.name, 120))
    return 'buyer needs an id and a name of at most 120 characters';
  const back = typeof input.returnUrl === 'string' ? httpsUrl(input.returnUrl) : null;
  if (!back) return 'returnUrl must be an https URL without credentials';
  if (isOwnHost(back.hostname, ownHosts))
    return 'returnUrl must be the buyer’s system, not this one';
  const origins = input.frameOrigins ?? [];
  if (!Array.isArray(origins) || origins.length > MAX_FRAME_ORIGINS)
    return `At most ${MAX_FRAME_ORIGINS} frameOrigins`;
  for (const o of origins) {
    const u = typeof o === 'string' ? httpsUrl(o) : null;
    if (!u || u.origin !== o) return `frameOrigins must be https origins, not “${String(o)}”`;
  }
  if (
    typeof input.expiresAt !== 'number' ||
    !(input.expiresAt > now) ||
    input.expiresAt - now > MAX_EXTERNAL_CART_MS
  )
    return 'expiresAt must be in the next 24 hours';
  const lines = input.lines ?? [];
  if (!Array.isArray(lines) || lines.length > MAX_CHECKOUT_LINES)
    return `At most ${MAX_CHECKOUT_LINES} lines`;
  for (const l of lines)
    if (!str(l?.sku, 120) || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_LINE_QUANTITY)
      return 'Each line is a SKU and a whole quantity from 1';
  return null;
}

/** The fields to post, or why a plugin's return can't be used. */
export function checkCartReturn(
  value: unknown,
): { ok: true; fields: Record<string, string> } | { ok: false; error: string } {
  const fields = (value as CartReturn | null)?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    return { ok: false, error: 'renderReturn must answer { fields }' };
  const entries = Object.entries(fields);
  if (entries.length > MAX_RETURN_FIELDS)
    return { ok: false, error: `At most ${MAX_RETURN_FIELDS} return fields` };
  let bytes = 0;
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !k) return { ok: false, error: 'Return fields are named strings' };
    bytes += k.length + v.length;
  }
  if (bytes > MAX_RETURN_BYTES) return { ok: false, error: 'The return is over 1 MiB' };
  return { ok: true, fields: Object.fromEntries(entries) };
}

/**
 * Idempotency-key namespaces the core starts orders under itself (carts, UCP, plugins, channels,
 * email, A2A, the stock review). A REST caller's key may not start with one.
 */
export const RESERVED_ORDER_KEY_PREFIXES = [
  'cart:',
  'ucp:',
  'plugin:',
  'order:',
  'email:',
  'a2a:',
  'replenish:',
] as const;

export const reservedOrderKey = (key: string) =>
  RESERVED_ORDER_KEY_PREFIXES.some((p) => key.startsWith(p));

/** Whether `host` is one of `own`, or under one of them (a trailing dot ignored). */
export function isOwnHost(host: string, own: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return own.some((o) => {
    const x = o.toLowerCase().replace(/\.$/, '');
    return !!x && (h === x || h.endsWith(`.${x}`));
  });
}

/** The idempotency key a plugin's order starts under: its own namespace, never another's. */
export const pluginOrderKey = (pluginId: string, key: string) => `plugin:${pluginId}:${key}`;
