/**
 * Cloudflare Turnstile on the two forms an anonymous caller can post a secret to: password sign-in
 * (`/login`) and the setup code (`/setup`). Bots stuffing passwords, or racing a new deployment's
 * first admin, need a fresh challenge token for every attempt; the token is checked here with
 * Siteverify before the password or code is looked at, so a refused attempt costs no hash and
 * counts toward no one's throttle.
 *
 * Optional per deployment: the registry's `turnstileSiteKey` renders `TURNSTILE_SITE_KEY`, and the
 * widget's secret is the `TURNSTILE_SECRET_KEY` secret (the deploy refuses a key without it).
 * Without a site key nothing changes: local development, tests and the demo's one-click sign-in.
 * Passkeys and single sign-on aren't gated (they can't be stuffed), nor is the two-factor step,
 * which only a password that passed this check can reach.
 */

import { env } from 'cloudflare:workers';
import { TURNSTILE_HEADER } from './csp';

/** What each form's widget says it protects; Siteverify must echo it back. */
export type TurnstileAction = 'login' | 'setup';

/** The form field the widget fills with its token. */
export const TOKEN_FIELD = 'cf-turnstile-response';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Siteverify's own limit; anything longer isn't a token. */
const MAX_TOKEN = 2048;

const config = () => env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string };

/** The site key the forms render their widget with, or null when this deployment has none. */
export const turnstileSiteKey = () => config().TURNSTILE_SITE_KEY || null;

/**
 * A route's response headers, marked so `entry.server.tsx` lets this page load Turnstile's script
 * and frame (`contentSecurityPolicy`) when the deployment uses it. No other page's policy does.
 */
export function withTurnstilePolicy(headers: Headers): Headers {
  if (!turnstileSiteKey()) return headers;
  const out = new Headers(headers);
  out.set(TURNSTILE_HEADER, '1');
  return out;
}

export type SiteverifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Asks Siteverify about `token`, and accepts it only if it passed, for this `action`, on this
 * `hostname`: a token solved on another deployment's page (one widget's domains include their
 * subdomains) or for the other form is refused. Fails closed: no answer, an error status or a body
 * that isn't Siteverify's is a refusal.
 */
export async function siteverify(
  input: {
    secret: string;
    token: string;
    remoteip?: string;
    action: TurnstileAction;
    hostname: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<SiteverifyResult> {
  if (!input.token || input.token.length > MAX_TOKEN) return { ok: false, reason: 'no-token' };
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteip) body.set('remoteip', input.remoteip);
  let result: { success?: unknown; hostname?: unknown; action?: unknown; 'error-codes'?: unknown };
  try {
    const res = await fetcher(SITEVERIFY, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `siteverify-${res.status}` };
    result = await res.json();
  } catch {
    return { ok: false, reason: 'siteverify-unreachable' };
  }
  if (result?.success !== true) {
    const codes = Array.isArray(result?.['error-codes']) ? result['error-codes'].join(',') : '';
    return { ok: false, reason: `failed${codes ? `:${codes}` : ''}` };
  }
  if (result.hostname !== input.hostname) return { ok: false, reason: 'wrong-hostname' };
  if (result.action !== input.action) return { ok: false, reason: 'wrong-action' };
  return { ok: true };
}

/** Why a form was refused, for the page: the message, and the status it answers with. */
export type TurnstileRefusal = { error: string; status: number };

/**
 * The form's Turnstile check: null when it passed or the deployment has no Turnstile, else what to
 * tell the person. A site key without its secret refuses everything (and says so in the log), so
 * a misconfigured deployment never quietly drops the check.
 */
export async function checkTurnstile(
  request: Request,
  form: FormData,
  action: TurnstileAction,
  fetcher: typeof fetch = fetch,
): Promise<TurnstileRefusal | null> {
  if (!turnstileSiteKey()) return null;
  const secret = config().TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error(
      JSON.stringify({
        type: 'turnstile_misconfigured',
        message:
          'TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not: every attempt is refused',
      }),
    );
    return {
      error: `${action === 'login' ? 'Signing in with a password' : 'Setting up'} is unavailable right now. Tell whoever runs this workspace.`,
      status: 503,
    };
  }
  const token = form.get(TOKEN_FIELD);
  const result = await siteverify(
    {
      secret,
      token: typeof token === 'string' ? token : '',
      remoteip: request.headers.get('cf-connecting-ip') ?? undefined,
      action,
      // The web Worker answers only at its deployment's domain (a custom domain, no workers.dev),
      // so the host it was asked at is the one the widget must have run on.
      hostname: new URL(request.url).hostname,
    },
    fetcher,
  );
  if (result.ok) return null;
  console.log(JSON.stringify({ type: 'turnstile_refused', action, reason: result.reason }));
  if (result.reason === 'no-token')
    return { error: 'Complete the check above, then try again.', status: 400 };
  if (result.reason.startsWith('siteverify-'))
    return { error: 'We couldn’t confirm the check just now. Try again in a moment.', status: 503 };
  return { error: 'The check didn’t pass. Try it again.', status: 403 };
}
