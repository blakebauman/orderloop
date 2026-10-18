/**
 * Secrets stored at rest (authenticator-app secrets, webhook and integration signing secrets, A2A
 * push credentials) are encrypted with AES-256-GCM under a key derived from the deployment's
 * `DATA_KEY`. A stored value reads `e1.<key id>.<iv>.<ciphertext>`, base64url; the key id says
 * which key sealed it, so a rotation can keep reading values under the key before it
 * (`DATA_KEY_PREVIOUS`) while they are sealed again under the new one.
 *
 * Each value is bound to where it lives (`context`, e.g. `users.totp_secret:<id>`) as associated
 * data: a ciphertext copied into another row doesn't decrypt.
 *
 * A value without the prefix was stored before encryption and is returned as it is; the sweep
 * that reseals values under the current key encrypts it.
 */

/**
 * Where each stored secret lives, as its encryption context. The web app writes these and the
 * engine reads and reseals them, so both take the context from here. An integration's or
 * subscription's current and previous secret share one, so a rotation moves the value as it is.
 */
export const secretContext = {
  totp: (userId: string) => `users.totp_secret:${userId}`,
  integration: (id: string) => `integrations:${id}`,
  webhookSubscription: (id: string) => `webhook_subscriptions:${id}`,
} as const;

/** Local dev's and tests' key (`vite.config.ts` gives it to both Workers). Never a deployment's. */
export const DEV_DATA_KEY = 'orderloop-local-dev-data-key';

const VERSION = 'e1';
const enc = new TextEncoder();
const dec = new TextDecoder();

type Derived = { id: string; key: Awaited<ReturnType<typeof crypto.subtle.deriveKey>> };
const derived = new Map<string, Promise<Derived>>();

/** The AES key and its id, both derived from the secret (HKDF and HMAC, each with its own label). */
function derive(secret: string): Promise<Derived> {
  let d = derived.get(secret);
  if (!d) {
    d = (async () => {
      const raw = enc.encode(secret);
      const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(),
          info: enc.encode('orderloop data v1'),
        },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const mac = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const tag = await crypto.subtle.sign('HMAC', mac, enc.encode('orderloop data key id'));
      return { id: b64url(new Uint8Array(tag).slice(0, 6)), key };
    })();
    derived.set(secret, d);
  }
  return d;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A stored value that can't be read: sealed under a key this deployment no longer has, or altered. */
export class SecretUnreadable extends Error {
  constructor(context: string) {
    super(`The secret at ${context} can't be decrypted with DATA_KEY or DATA_KEY_PREVIOUS`);
    this.name = 'SecretUnreadable';
  }
}

/** Whether a stored value is encrypted (rather than stored before encryption). */
export const isEncrypted = (stored: string) => stored.startsWith(`${VERSION}.`);

/**
 * Encrypts `plaintext` for `context` under the first of `keys` (the current `DATA_KEY`; the
 * others are only read with). Throws when there is no key.
 */
export async function encryptSecret(
  keys: readonly (string | undefined)[],
  plaintext: string,
  context: string,
): Promise<string> {
  const secret = keys[0];
  if (!secret) throw new Error('DATA_KEY is not set: secrets can’t be stored');
  const { id, key } = await derive(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(context) },
    key,
    enc.encode(plaintext),
  );
  return `${VERSION}.${id}.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

/**
 * The plaintext of a stored value, under whichever of `keys` sealed it. A value stored before
 * encryption comes back unchanged. Throws `SecretUnreadable` when no key opens it.
 */
export async function decryptSecret(
  keys: readonly (string | undefined)[],
  stored: string,
  context: string,
): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  const [, kid, iv, ct, extra] = stored.split('.');
  if (!kid || !iv || !ct || extra !== undefined) throw new SecretUnreadable(context);
  for (const secret of keys) {
    if (!secret) continue;
    const { id, key } = await derive(secret);
    if (id !== kid) continue;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(context) },
        key,
        fromB64url(ct),
      );
      return dec.decode(pt);
    } catch {
      break;
    }
  }
  throw new SecretUnreadable(context);
}

/** Whether a stored value is already encrypted under the current key (nothing for a reseal to do). */
export async function sealedWithCurrent(
  keys: readonly (string | undefined)[],
  stored: string,
): Promise<boolean> {
  if (!keys[0] || !isEncrypted(stored)) return false;
  return stored.split('.')[1] === (await derive(keys[0])).id;
}
