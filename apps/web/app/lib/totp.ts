/**
 * Two-factor primitives, WebCrypto only: time-based one-time codes (RFC 6238, the six-digit codes
 * authenticator apps show) and recovery codes.
 *
 * A secret is 20 random bytes, shown to the person as base32 and in an `otpauth://` QR code.
 * Codes are HMAC-SHA1 over 30-second steps; one step either side is accepted for clock drift, and
 * `auth.server.ts` remembers the last step used so a code can't be replayed.
 */

import { sha256Hex } from './credentials';

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that still count, for a phone clock that is a little off. */
const DRIFT = 1;
const SECRET_BYTES = 20;
export const ISSUER = 'OrderLoop';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32, ignoring case, spaces and padding; null when it isn't base32. */
export function fromBase32(s: string): Uint8Array<ArrayBuffer> | null {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** A new secret, base32. */
export const newTotpSecret = () => base32(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));

/** What an authenticator app scans: `otpauth://totp/OrderLoop:ann@example.com?secret=…`. */
export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`${ISSUER}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`;
}

export const totpStep = (ms: number) => Math.floor(ms / 1000 / TOTP_PERIOD_S);

/** The code for one 30-second step. */
export async function totpCode(secret: Uint8Array<ArrayBuffer>, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(step / 2 ** 32));
  counter.setUint32(4, step >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = mac[mac.length - 1]! & 0x0f;
  const n =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(n % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Digits only, so "123 456" and "123-456" are typed codes too. */
export const cleanCode = (code: string) => code.replace(/[\s-]/g, '');

export const looksLikeTotp = (code: string) =>
  new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(cleanCode(code));

/**
 * The step a code matches, or null. Steps at or before `after` (the last one used) don't count,
 * so the same code can't be used twice.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  now: number,
  after: number | null = null,
): Promise<number | null> {
  const key = fromBase32(secret);
  const given = cleanCode(code);
  if (!key || !looksLikeTotp(given)) return null;
  const at = totpStep(now);
  let match: number | null = null;
  for (let step = at - DRIFT; step <= at + DRIFT; step++) {
    if (after !== null && step <= after) continue;
    // Check every step, rather than stopping at a match, so timing says nothing about which.
    if ((await totpCode(key, step)) === given && match === null) match = step;
  }
  return match;
}

// ── Recovery codes ──

export const RECOVERY_CODE_COUNT = 10;
/** No 0/o, 1/l/i: easy to read off paper. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten codes like `k7mqp-3xw9d`, each good for one sign-in. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const s = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Typed recovery codes ignore case, spaces and the dash. */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, '');

export const hashRecoveryCode = (code: string) => sha256Hex(normalizeRecoveryCode(code));
