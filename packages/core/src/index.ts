export * from './api';
export * from './catalog';
export * from './graph';
export * from './layout';
export * from './logic';
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
export * from './webhooks';
