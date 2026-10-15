import { data } from 'react-router';
import { clientIp } from '~/lib/audit.server';
import { cookie, Throttled } from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import {
  clearPasskeyCookie,
  PASSKEY_COOKIE,
  signInOptions,
  signInWithPasskey,
} from '~/lib/passkeys.server';
import { overBudget } from '~/lib/rate-limit';
import type { Route } from './+types/login-passkey';

/**
 * The sign-in page's passkey steps, as JSON: `options` starts one (and sets the cookie tying the
 * answer to it), `verify` checks the browser's answer and signs the person in.
 */
export async function action({ request }: Route.ActionArgs) {
  const body = (await request.json().catch(() => ({}))) as {
    step?: string;
    response?: Parameters<typeof signInWithPasskey>[2];
  };
  if (body.step === 'options') {
    // Anyone may ask, and each ask stores a challenge: a budget per address keeps that bounded.
    const limited = await overBudget('API_LIMIT', `passkey:${clientIp(request)}`);
    if (limited) return limited;
    const { options, cookie: set } = await signInOptions(request);
    return data({ options }, { headers: { 'set-cookie': set } });
  }
  if (body.step === 'verify' && body.response) {
    try {
      const session = await signInWithPasskey(
        request,
        cookie(request, PASSKEY_COOKIE),
        body.response,
      );
      const headers = new Headers({ 'set-cookie': clearPasskeyCookie });
      if (!session)
        return data(
          { error: 'That passkey didn’t sign you in. Try again, or use your email and password.' },
          { status: 401, headers },
        );
      headers.append('set-cookie', session);
      return data({ location: nextPath(request) }, { headers });
    } catch (err) {
      if (!(err instanceof Throttled)) throw err;
      return data(
        { error: err.message },
        { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
      );
    }
  }
  return data({ error: 'Unknown step' }, { status: 400 });
}
