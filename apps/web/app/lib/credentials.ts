/**
 * Credential primitives, WebCrypto only.
 *
 * Passwords are PBKDF2-SHA256 stored as `pbkdf2:<iterations>:<salt>:<hash>` (base64url parts).
 * workerd caps PBKDF2 at 100k iterations; the count travels with the hash so it can rise later.
 * Session and API tokens are random and stored only as SHA-256.
 */

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/** API tokens look like `ol_live_<32 base64url chars>`; the first 12 characters are shown. */
export const API_TOKEN_PREFIX = 'ol_live_';

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A high-entropy opaque token. */
export function randomToken(byteLen = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLen)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two secrets in constant time, length included: it compares their SHA-256 digests. */
export async function secretEqual(a: string, b: string): Promise<boolean> {
  return safeEqual(await sha256Hex(a), await sha256Hex(b));
}

/** Constant time for equal-length inputs; different lengths fail fast, which leaks only length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BITS,
  );
  return base64url(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2:${ITERATIONS}:${base64url(salt)}:${await derive(password, salt, ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, expected] = stored.split(':');
  if (scheme !== 'pbkdf2' || !iterStr || !saltB64 || !expected) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  return safeEqual(await derive(password, base64urlToBytes(saltB64), iterations), expected);
}

/** A password an operator hands to a new user, or after a reset: 20 characters, about 120 bits. */
export function generatePassword(): string {
  return randomToken(15);
}

/** A new API token, its stored hash and the prefix shown in lists. */
export async function newApiToken() {
  const token = `${API_TOKEN_PREFIX}${randomToken(24)}`;
  return { token, hash: await sha256Hex(token), prefix: token.slice(0, 12) };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const isEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'welcome1',
  'admin123',
  'letmein1',
]);

/** The password policy: 10 to 256 characters, not common, not the email. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 256) return 'Use at most 256 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common.';
  const local = email.split('@')[0]?.toLowerCase();
  if (lower.includes(email.toLowerCase()) || (local && local.length >= 4 && lower.includes(local)))
    return 'Don’t include your email address.';
  return null;
}
