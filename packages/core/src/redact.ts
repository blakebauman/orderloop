/**
 * What a model may see of an order. Workflow AI nodes (classify, risk, router, summarize, assess)
 * get the order's commercial facts: lines, amounts, channel, fulfilment method, ship-to country.
 * With personal data redacted (the default), they don't get who the buyer is or where they live:
 * no contact, names, emails, phone numbers, street addresses or payment ids, and email addresses
 * and phone numbers in free text are masked. A deployment that needs them (a router that decides
 * by customer name) sets `send`. Extract still reads the inbound document whole: finding the
 * buyer in it is its job.
 */

import { shipToCountry } from './shipping';
import type { Order } from './types';

export const PERSONAL_DATA_MODES = ['redact', 'send'] as const;
export type PersonalDataMode = (typeof PERSONAL_DATA_MODES)[number];

/** The mode a deployment's `AI_PERSONAL_DATA` asks for; anything but `send` redacts. */
export const personalDataMode = (value: string | undefined): PersonalDataMode =>
  value === 'send' ? 'send' : 'redact';

/** Keys whose values identify or locate a person, wherever they appear. */
const PERSONAL_KEYS = new Set(
  [
    'address',
    'address1',
    'address2',
    'billTo',
    'buyer',
    'city',
    'contact',
    'customerName',
    'email',
    'firstName',
    'lastName',
    'line1',
    'line2',
    'name',
    'phone',
    'postalCode',
    'shipTo',
    'street',
    'zip',
  ].map((k) => k.toLowerCase().replace(/[_-]/g, '')),
);
const isPersonalKey = (key: string) => PERSONAL_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// Digits with the usual separators, e.g. +1 (555) 010-0199; at least nine digits, so a date
// (2026-10-15) or an amount stays.
const PHONE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const phoneLike = (m: string) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m);

/** Masks email addresses and phone numbers in free text. */
export const maskPersonalText = (text: string) =>
  text.replace(EMAIL, '[email]').replace(PHONE, phoneLike);

/** A JSON value with personal keys dropped and personal text masked, at any depth. */
export function scrubPersonal(value: unknown): unknown {
  if (typeof value === 'string') return maskPersonalText(value);
  if (Array.isArray(value)) return value.map(scrubPersonal);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !isPersonalKey(k))
        .map(([k, v]) => [k, scrubPersonal(v)]),
    );
  return value;
}

/** The order as a model sees it. Never internal bookkeeping, the document text or payment ids. */
export function modelOrder(order: Order, mode: PersonalDataMode) {
  const facts = {
    id: order.id,
    model: order.model,
    channel: order.channel,
    customerId: order.customerId,
    lines: order.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      ...(l.sellerId ? { sellerId: l.sellerId } : {}),
    })),
    subtotal: order.subtotal,
    shipping: order.shipping ?? 0,
    shippingOption: order.shippingOption,
    tax: order.tax,
    total: order.total,
    baseTotal: order.baseTotal,
    currency: order.currency,
    fulfillment: order.fulfillment ? { method: order.fulfillment.method } : undefined,
  };
  if (mode === 'send')
    return { ...facts, title: order.title, contact: order.contact, meta: order.meta };
  return {
    ...facts,
    title: order.title ? maskPersonalText(order.title) : undefined,
    /** A buyer without a customer account who left contact details. */
    guest: !order.customerId && !!order.contact,
    shipToCountry: shipToCountry(order),
    meta: scrubPersonal(order.meta ?? {}) as Record<string, unknown>,
  };
}

type CustomerRow = {
  id: string;
  name: string;
  email: string;
  kind: string;
  tier: string;
  creditLimit: number;
  balance: number;
  terms: string;
};

/** A customer as a model sees it: their account terms, and only with `send` their name and email. */
export function modelCustomer(customer: CustomerRow | undefined, mode: PersonalDataMode) {
  if (!customer) return undefined;
  const account = {
    id: customer.id,
    kind: customer.kind,
    tier: customer.tier,
    creditLimit: customer.creditLimit,
    balance: customer.balance,
    terms: customer.terms,
  };
  return mode === 'send' ? { ...account, name: customer.name, email: customer.email } : account;
}

/**
 * A model's view of a running order: the order, its customer, the run's vars and completed steps'
 * outputs, each redacted for `mode`. Keys left out stay out.
 */
export type ModelContextInput = {
  order: Order;
  customer?: CustomerRow | undefined;
  vars?: unknown;
  completed?: unknown;
};

export function modelContext(mode: PersonalDataMode, c: ModelContextInput) {
  const loose = (v: unknown) => (mode === 'send' ? v : scrubPersonal(v));
  return {
    order: modelOrder(c.order, mode),
    ...('customer' in c ? { customer: modelCustomer(c.customer, mode) } : {}),
    ...('vars' in c ? { vars: loose(c.vars) } : {}),
    ...('completed' in c ? { completed: loose(c.completed) } : {}),
  };
}
