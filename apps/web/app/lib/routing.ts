/**
 * Which inbound orders each flow receives, in words, for the flows list: the `ORDER_ROUTES` entries
 * and built-in routes that name it, whether it is its model's default, and the intake mailboxes
 * that start it. Pure; mirrors `flowForOrder` and the email intake.
 */

import {
  DEFAULT_ORDER_ROUTES,
  DEFAULT_TEMPLATE,
  ORDER_CHANNEL_LABELS,
  ORDER_MODEL_LABELS,
  type OrderChannel,
  type OrderModel,
} from '@orderloop/core';

export type Receives = {
  /** e.g. ["Marketplace, any channel (default)", "Email to orders@"]. */
  lines: string[];
  /** The model's default: it gets that model's orders nothing else routes. */
  isDefault: boolean;
};

const model = (m: string) => ORDER_MODEL_LABELS[m as OrderModel] ?? m;
const channel = (c: string) =>
  c === '*' ? 'any channel' : (ORDER_CHANNEL_LABELS[c as OrderChannel] ?? c);

export function receives(
  flow: { id: string; model: OrderModel },
  routes: Record<string, string>,
  mailboxes: Record<string, string>,
): Receives {
  const all = { ...DEFAULT_ORDER_ROUTES, ...routes };
  const lines: string[] = [];
  for (const [key, to] of Object.entries(all)) {
    if (to !== flow.id) continue;
    const [m = '', c = ''] = key.split(':');
    lines.push(`${model(m)}, ${channel(c)}`);
  }
  const isDefault = DEFAULT_TEMPLATE[flow.model] === flow.id && !all[`${flow.model}:*`];
  if (isDefault) {
    const elsewhere = Object.entries(all).some(
      ([key, to]) => key.startsWith(`${flow.model}:`) && to !== flow.id,
    );
    lines.unshift(
      `${model(flow.model)}, ${elsewhere ? 'other channels' : 'any channel'} (default)`,
    );
  }
  for (const [box, to] of Object.entries(mailboxes))
    if (to === flow.id) lines.push(`Email to ${box}@`);
  return { lines, isDefault };
}
