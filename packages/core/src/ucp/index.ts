/**
 * The Universal Commerce Protocol (https://ucp.dev), version `UCP_VERSION`: the business side of
 * discovery, checkout, fulfillment and orders, mapped onto the protocol-neutral checkout
 * (../checkout.ts) and OrderLoop's orders. Pure; the engine serves it (apps/engine/src/ucp/) and
 * the web Worker fronts it (apps/web/app/lib/ucp.server.ts).
 */

export * from './checkout';
export * from './errors';
export * from './order';
export * from './profile';
export * from './signature';
export * from './structured';
