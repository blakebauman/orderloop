import { redirect } from 'react-router';
import { clientIp } from '~/lib/audit.server';
import { nextPath } from '~/lib/next-path';
import { overBudget } from '~/lib/rate-limit';
import { SsoError, ssoConfig, startSso } from '~/lib/sso.server';
import type { Route } from './+types/login-sso';

/**
 * Starts single sign-on: off to the identity provider, with this browser's flow in a cookie. A
 * plain link reaches it (a GET), so the CSP's `form-action 'self'` doesn't stand in the way.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const c = ssoConfig();
  if (!c) throw redirect('/login');
  // Anyone may start one, and each start asks the provider's discovery: a budget per address.
  const limited = await overBudget('API_LIMIT', `sso:${clientIp(request)}`);
  if (limited) return limited;
  const next = nextPath(request);
  try {
    const { location, cookie } = await startSso(request, c, next);
    return redirect(location, { headers: { 'set-cookie': cookie } });
  } catch (err) {
    if (!(err instanceof SsoError)) throw err;
    console.error('sso start', err.reason);
    throw redirect(`/login?sso=failed&next=${encodeURIComponent(next)}`);
  }
}
