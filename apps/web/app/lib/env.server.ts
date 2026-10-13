import { env } from 'cloudflare:workers';
import type { EngineRpc } from '@orderloop/core';
import { createDb } from '@orderloop/db';

/** The engine Worker, typed by the shared RPC contract. */
export function engine(): EngineRpc & Pick<Fetcher, 'fetch'> {
  return env.ENGINE as unknown as EngineRpc & Pick<Fetcher, 'fetch'>;
}

export function db() {
  return createDb(env.DB);
}

export function docs() {
  return env.DOCS;
}
