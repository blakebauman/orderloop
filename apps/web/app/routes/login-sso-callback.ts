import { redirect } from 'react-router';
import { audit } from '~/lib/audit.server';
import { principal, recordReauth } from '~/lib/auth.server';
import {
  clearSsoCookie,
  SsoError,
  signInWithSso,
  ssoConfig,
  verifyCallback,
} from '~/lib/sso.server';
import type { Route } from './+types/login-sso-callback';

/** Where the identity provider sends people back: check its answer and sign them in. */
export async function loader({ request }: Route.LoaderArgs) {
  const c = ssoConfig();
  if (!c) throw redirect('/login');
  const headers = new Headers({ 'set-cookie': clearSsoCookie });
  try {
    const { identity, next, reauthAt } = await verifyCallback(request, c);
    const me = await principal(request);
    if (me) {
      // A step-up: it counts on this session only if the provider vouched for the same person.
      if (reauthAt !== null) {
        if (await recordReauth(request, me, identity.sub, reauthAt))
          await audit(request, 'auth.reauthenticated', { actor: me, detail: { method: 'sso' } });
        else
          await audit(request, 'auth.sign_in_failed', {
            actor: me,
            detail: { reason: 'step-up by another identity', method: 'sso' },
          });
      }
      // Otherwise another tab finished first: keep that session.
      return redirect(next, { headers });
    }
    headers.append('set-cookie', await signInWithSso(request, identity));
    return redirect(next, { headers });
  } catch (err) {
    if (!(err instanceof SsoError)) throw err;
    // The audit log says why; the page says only what the person can do about it.
    await audit(request, 'auth.sign_in_failed', {
      detail: { reason: err.reason, method: 'sso' },
    });
    return redirect(`/login?sso=${err.code}`, { headers });
  }
}
