export * from './a2a';
export * from './address';
export * from './api';
export * from './assess';
export * from './assistant';
export * from './catalog';
export * from './channels/shopify';
export * from './channels/x12';
export * from './fulfillment';
export * from './graph';
export * from './health';
export * from './integrations';
export * from './json-schema';
export * from './layout';
export * from './lines';
export * from './logic';
export * from './policy';
export * from './pricing';
export * from './roles';
export * from './shipping';
export * from './templates';
export * from './types';

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
