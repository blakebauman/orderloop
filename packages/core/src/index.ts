export * from './a2a';
export * from './address';
export * from './api';
export * from './assess';
export * from './assistant';
export * from './audit';
export * from './cart';
export * from './catalog';
export * from './channels/shopify';
export * from './channels/x12';
export * from './checkout';
export * from './credentials';
export * from './egress';
export * from './encryption';
export * from './erasure';
export * from './extract-catalog';
export * from './fulfillment';
export * from './graph';
export * from './health';
export * from './integrations';
export * from './json-schema';
export * from './layout';
export * from './lines';
export * from './logic';
export * from './mcp-skills';
export * from './money';
export * from './order-schemas';
export * from './payments';
export * from './plugin-host';
export * from './plugin-ui';
export * from './plugins';
export * from './policy';
export * from './pricing';
export * from './promotions';
export * from './provenance';
export * from './redact';
export * from './roles';
export * from './shipping';
export * from './tax-exemption';
export * from './templates';
export * from './types';
export * from './ucp';
export * from './untrusted';

/** Short, sortable, URL-safe ids: a prefix, base36 time and randomness. */
export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const tail = Array.from(rand, (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${Date.now().toString(36)}${tail}`;
}

/** The OrderAgent Durable Object name for an order. */
export const orderAgentName = (orderId: string) => orderId;
export * from './inbound';
export * from './intake';
export * from './webhooks';
