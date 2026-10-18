import { env } from 'cloudflare:workers';
import { DEV_DATA_KEY, decryptSecret, encryptSecret } from '@orderloop/core';

/**
 * The keys secrets at rest are encrypted with: `DATA_KEY`, then `DATA_KEY_PREVIOUS` while a
 * rotation finishes (the engine's daily sweep reseals everything under the new key). The engine
 * holds the same two. Local dev (`vite dev`) uses a fixed key when none is set.
 */
function dataKeys(): [string, string | undefined] {
  const e = env as { DATA_KEY?: string; DATA_KEY_PREVIOUS?: string };
  const current = e.DATA_KEY || (import.meta.env.DEV ? DEV_DATA_KEY : undefined);
  if (!current) throw new Error('DATA_KEY is not set: secrets can’t be stored or read');
  return [current, e.DATA_KEY_PREVIOUS];
}

/** `plaintext` encrypted for `context` (where it is stored, e.g. `users.totp_secret:<id>`). */
export const sealSecret = (plaintext: string, context: string) =>
  encryptSecret(dataKeys(), plaintext, context);

/** A stored secret's plaintext. Throws `SecretUnreadable` when neither key opens it. */
export const openSecret = (stored: string, context: string) =>
  decryptSecret(dataKeys(), stored, context);
