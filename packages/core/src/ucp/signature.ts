/**
 * HTTP Message Signatures (RFC 9421) as UCP profiles them: ES256 over a signature base of the
 * request's derived components and headers, the body bound by `Content-Digest` (RFC 9530,
 * sha-256 over the raw bytes), the key named by `keyid` and published in the signer's profile
 * (`keys`). ECDSA signatures are raw `r||s`, which is what WebCrypto produces.
 *
 * OrderLoop signs its order webhooks with this and verifies with it in tests; it would also verify
 * a platform that signs its requests.
 */

import {
  type InnerList,
  isInnerList,
  parseDictionary,
  serializeInnerList,
  serializeItem,
} from './structured';

const enc = new TextEncoder();

/** An EC JSON Web Key (private when it has `d`). */
export type EcJwk = {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  kid?: string;
};
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** `Content-Digest` for a body: `sha-256=:<base64>:`. */
export async function contentDigest(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === 'string' ? enc.encode(body) : new Uint8Array(body);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha-256=:${b64(digest)}:`;
}

/** Whether `header` carries the sha-256 digest of `body`. */
export async function digestMatches(header: string | null, body: string | Uint8Array) {
  const dict = parseDictionary(header);
  const m = dict?.get('sha-256');
  if (!m || isInnerList(m) || !(m.value instanceof Uint8Array)) return false;
  const want = (await contentDigest(body)).slice('sha-256=:'.length, -1);
  return b64(m.value) === want;
}

/** What a signature can cover: the request's parts and its headers (by lower-case name). */
export type SignedMessage = {
  method?: string;
  /** Absolute URL: gives `@authority`, `@path` and `@query`. */
  url?: string;
  status?: number;
  headers: Headers;
};

function component(name: string, m: SignedMessage): string | null {
  const url = m.url ? new URL(m.url) : null;
  switch (name) {
    case '@method':
      return m.method?.toUpperCase() ?? null;
    case '@authority':
      return url ? url.host.toLowerCase() : null;
    case '@path':
      return url ? url.pathname || '/' : null;
    case '@query':
      return url ? url.search || '?' : null;
    case '@target-uri':
      return url ? url.href : null;
    case '@status':
      return m.status === undefined ? null : String(m.status);
    default:
      return name.startsWith('@') ? null : (m.headers.get(name)?.trim() ?? null);
  }
}

/** The signature base (RFC 9421 §2.5), or null when a covered component is missing. */
function signatureBase(params: InnerList, m: SignedMessage): string | null {
  const lines: string[] = [];
  for (const item of params.items) {
    if (typeof item.value !== 'string') return null;
    const v = component(item.value, m);
    if (v === null) return null;
    lines.push(`"${item.value}": ${v}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(params)}`);
  return lines.join('\n');
}

const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** A private P-256 JWK for signing. */
export const importSigningKey = (jwk: EcJwk): Promise<Key> =>
  crypto.subtle.importKey('jwk', jwk as never, P256, false, ['sign']);

/** A public P-256 JWK for verifying. */
export const importVerifyKey = (jwk: EcJwk): Promise<Key> =>
  crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as never,
    P256,
    false,
    ['verify'],
  );

/** The public half of a private EC JWK, as a profile publishes it. */
export function publicJwk(jwk: EcJwk) {
  return {
    kid: jwk.kid ?? '',
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x!,
    y: jwk.y!,
    alg: 'ES256',
    use: 'sig',
  };
}

/**
 * Signs `m` over `components` and returns the `Signature-Input` and `Signature` header values
 * (label `sig1`). The caller sets `Content-Digest` (and any other covered header) first.
 */
export async function signMessage(
  m: SignedMessage,
  components: string[],
  key: Key,
  keyid: string,
  created = Math.floor(Date.now() / 1000),
) {
  const params: InnerList = {
    items: components.map((value) => ({ value, params: {} })),
    params: { created, keyid },
  };
  const base = signatureBase(params, m);
  if (base === null) throw new Error('A covered component is missing from the message');
  const sig = new Uint8Array(await crypto.subtle.sign(ES256, key, enc.encode(base)));
  return {
    signatureInput: `sig1=${serializeInnerList(params)}`,
    signature: `sig1=${serializeItem({ value: sig, params: {} })}`,
  };
}

export type SignatureCheck =
  | { ok: true; keyid: string; components: string[] }
  | { ok: false; reason: string };

/**
 * Checks the first signature on `m` whose covered components include `required`, with the key
 * `keyFor` returns for its `keyid` (null for an unknown key). The body's digest is the caller's
 * to check (`digestMatches`) when `content-digest` is covered.
 */
export async function verifyMessage(
  m: SignedMessage,
  keyFor: (keyid: string) => Promise<Key | null>,
  required: string[] = [],
): Promise<SignatureCheck> {
  const inputs = parseDictionary(m.headers.get('signature-input'));
  const sigs = parseDictionary(m.headers.get('signature'));
  if (!inputs || !sigs || !inputs.size) return { ok: false, reason: 'missing signature' };
  for (const [label, input] of inputs) {
    if (!isInnerList(input)) continue;
    const covered = input.items.map((i) => String(i.value));
    if (!required.every((r) => covered.includes(r))) continue;
    const sig = sigs.get(label);
    if (!sig || isInnerList(sig) || !(sig.value instanceof Uint8Array))
      return { ok: false, reason: `no signature for ${label}` };
    const keyid = input.params.keyid;
    if (typeof keyid !== 'string') return { ok: false, reason: 'no keyid' };
    const key = await keyFor(keyid);
    if (!key) return { ok: false, reason: `unknown key ${keyid}` };
    const base = signatureBase(input, m);
    if (base === null) return { ok: false, reason: 'a covered component is missing' };
    const valid = await crypto.subtle.verify(
      ES256,
      key,
      new Uint8Array(sig.value),
      enc.encode(base),
    );
    return valid
      ? { ok: true, keyid, components: covered }
      : { ok: false, reason: 'bad signature' };
  }
  return { ok: false, reason: `no signature covers ${required.join(', ')}` };
}
