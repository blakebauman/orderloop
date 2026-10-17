/** What the UCP tests share: a registered platform, requests as the web Worker forwards them. */

import { env } from 'cloudflare:workers';
import {
  CHECKOUT_CAPABILITY,
  FULFILLMENT_CAPABILITY,
  ORDER_CAPABILITY,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  signPlatform,
  UCP_SETTINGS_KEY,
  UCP_VERSION,
} from '@orderloop/core';
import { createDb, ucpPlatforms, workspaceSettings } from '@orderloop/db';
import worker from '../src/index';

export const ORIGIN = 'https://shop.example';
export const HOOK = 'https://platform.example/hooks/orders';
export const db = () => createDb(env.DB);
export const principalKey = (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!;

const entry = (name: string) => ({
  version: UCP_VERSION,
  spec: `https://ucp.dev/${UCP_VERSION}/specification/${name}`,
  schema: `https://ucp.dev/${UCP_VERSION}/schemas/${name}.json`,
});
export const platformProfile = (version = UCP_VERSION, order = true) => ({
  ucp: {
    version,
    services: {},
    payment_handlers: {},
    capabilities: {
      [CHECKOUT_CAPABILITY]: [entry('shopping/checkout')],
      [FULFILLMENT_CAPABILITY]: [
        { ...entry('shopping/fulfillment'), extends: CHECKOUT_CAPABILITY },
      ],
      ...(order
        ? { [ORDER_CAPABILITY]: [{ ...entry('shopping/order'), config: { webhook_url: HOOK } }] }
        : {}),
    },
  },
});

/** A registered platform whose profile is already cached on its row. */
export async function platform(
  id: string,
  profile: unknown = platformProfile(),
): Promise<PlatformCaller> {
  const caller = { id, name: id, profileUrl: `https://${id}.example/profile`, origin: ORIGIN };
  await db()
    .insert(ucpPlatforms)
    .values({
      id,
      name: id,
      profileUrl: caller.profileUrl,
      keyPrefix: 'ol_ucp_test',
      keyHash: `hash_${id}`,
      profile: JSON.stringify(profile),
      profileFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  return caller;
}

/** A request to /ucp as the web Worker forwards it for `caller`. */
export async function ucp(
  caller: PlatformCaller | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const h = new Headers({ 'content-type': 'application/json', ...headers });
  if (caller)
    h.set(
      PRINCIPAL_HEADER,
      await signPlatform(principalKey, caller, new URL(path, 'https://engine').pathname),
    );
  const res = await worker.fetch(
    new Request(`https://engine${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export const address = {
  street_address: '500 Congress Ave',
  address_locality: 'Austin',
  address_region: 'TX',
  postal_code: '78701',
  address_country: 'US',
  first_name: 'Ada',
  last_name: 'Lovelace',
};
export const monitorCheckout = {
  line_items: [{ item: { id: 'MON-27' }, quantity: 1 }],
  buyer: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
  fulfillment: { methods: [{ type: 'shipping', destinations: [address] }] },
};
export const pay = (token = 'tok_test_visa', handler = 'test', type = 'test') => ({
  payment: {
    instruments: [{ id: 'inst_1', handler_id: handler, type: 'card', credential: { type, token } }],
  },
});
export const key = () => crypto.randomUUID();

export async function until<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  ms = 30_000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Turns agentic checkout on with the storefront flow. */
export async function enableUcp() {
  await db()
    .insert(workspaceSettings)
    .values({
      key: UCP_SETTINGS_KEY,
      value: JSON.stringify({
        checkoutFlowId: 'tpl-storefront-order',
        links: [{ type: 'terms_of_service', url: 'https://shop.example/terms' }],
        orderUrl: 'https://shop.example/orders/{id}',
      }),
      updatedAt: Date.now(),
      updatedBy: 'test',
    })
    .onConflictDoNothing();
}
