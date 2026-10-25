import { env, waitUntil } from 'cloudflare:workers';
import type { EngineRpc } from '@orderloop/core';
import type { ProductCatalogRpc } from '@orderloop/core/product';
import { createDb } from '@orderloop/db';

/** The engine Worker, typed by the shared RPC contract. */
export function engine(): EngineRpc & Pick<Fetcher, 'fetch'> {
  return env.ENGINE as unknown as EngineRpc & Pick<Fetcher, 'fetch'>;
}

/** The catalog Worker, typed by its RPC contract. */
export function catalog(): ProductCatalogRpc {
  return env.CATALOG as unknown as ProductCatalogRpc;
}

/**
 * The deployment's password pepper (`PASSWORD_PEPPER`), mixed into every password hash and never
 * stored with them; unset in local development, where hashes are made without one.
 */
export function passwordPepper(): string | undefined {
  return (env as { PASSWORD_PEPPER?: string }).PASSWORD_PEPPER || undefined;
}

export function db() {
  return createDb(env.DB);
}

export function docs() {
  return env.DOCS;
}

/**
 * Runs bookkeeping (a session's or a key's last use) after the response instead of before it.
 * The write still happens: the Worker stays alive until it settles. A failure is logged.
 */
export function afterResponse(work: PromiseLike<unknown>) {
  waitUntil(Promise.resolve(work).catch((err) => console.error('background write failed', err)));
}
