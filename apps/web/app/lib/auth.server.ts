/**
 * Single-password access for the MVP. When APP_PASSWORD is unset (local dev) everything is open.
 * The UI uses an HttpOnly cookie holding an HMAC of the password; the REST API takes
 * `Authorization: Bearer <APP_PASSWORD>`. Put Cloudflare Access in front for real users.
 */

import { env } from 'cloudflare:workers';
import { redirect } from 'react-router';

const COOKIE = 'ol_session';

function password(): string | undefined {
  return (env as { APP_PASSWORD?: string }).APP_PASSWORD || undefined;
}

async function token(pw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('orderloop-session'));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, '');
}

function cookieValue(request: Request): string | undefined {
  const raw = request.headers.get('cookie') ?? '';
  return raw
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isSignedIn(request: Request): Promise<boolean> {
  const pw = password();
  if (!pw) return true;
  const v = cookieValue(request);
  return !!v && timingSafeEqual(v, await token(pw));
}

/** Loader/action guard for UI routes. */
export async function requireUser(request: Request): Promise<void> {
  if (await isSignedIn(request)) return;
  const url = new URL(request.url);
  throw redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
}

export async function isApiAuthorized(request: Request): Promise<boolean> {
  const pw = password();
  if (!pw) return true;
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return timingSafeEqual(bearer, pw) || (await isSignedIn(request));
}

export async function signIn(given: string): Promise<string | null> {
  const pw = password();
  if (!pw || !timingSafeEqual(given, pw)) return null;
  return `${COOKIE}=${await token(pw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

export const signOutCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export const authEnabled = () => !!password();
