/**
 * Signed inbound webhooks. External systems (payment providers, a WMS, suppliers) resume orders
 * by POSTing an event signed with the shared WEBHOOK_SECRET instead of holding the admin password.
 *
 *   X-OrderLoop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>
 *
 * The timestamp is part of the signed payload and must be within `toleranceSec` of now, so a
 * captured request can't be replayed later.
 */

export const SIGNATURE_HEADER = 'x-orderloop-signature';

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Builds the signature header value for `rawBody` (what a sender does). */
export async function signWebhook(
  secret: string,
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
) {
  return `t=${nowSec},v1=${await hmacHex(secret, `${nowSec}.${rawBody}`)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyWebhook(
  secret: string,
  rawBody: string,
  header: string | null,
  { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {},
): Promise<VerifyResult> {
  if (!header) return { ok: false, reason: 'Missing signature header' };
  const parts = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'Malformed signature header' };
  if (Math.abs(nowSec - t) > toleranceSec)
    return { ok: false, reason: 'Signature timestamp outside tolerance' };
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, v1.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'Signature mismatch' };
}
