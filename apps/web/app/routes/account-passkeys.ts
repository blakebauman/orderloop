import { data } from 'react-router';
import { requireUser, Throttled } from '~/lib/auth.server';
import { addPasskey, registrationOptions, removePasskey } from '~/lib/passkeys.server';
import { TeamError } from '~/lib/team.server';
import type { Route } from './+types/account-passkeys';

/**
 * The Account page's passkey steps, as JSON: `options` (after the password checks out) and `add`
 * register one; `remove` deletes one, again after the password.
 */
export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const body = (await request.json().catch(() => ({}))) as {
    step?: string;
    password?: string;
    name?: string;
    id?: string;
    response?: Parameters<typeof addPasskey>[2];
  };
  try {
    if (body.step === 'options')
      return { options: await registrationOptions(request, me, String(body.password ?? '')) };
    if (body.step === 'add' && body.response) {
      await addPasskey(request, me, body.response, String(body.name ?? ''));
      return { ok: true };
    }
    if (body.step === 'remove' && body.id) {
      await removePasskey(request, me, body.id, String(body.password ?? ''));
      return { ok: true };
    }
    return data({ error: 'Unknown step' }, { status: 400 });
  } catch (err) {
    if (err instanceof Throttled)
      return data(
        { error: err.message },
        { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
      );
    if (err instanceof TeamError) return data({ error: err.message }, { status: 400 });
    throw err;
  }
}
