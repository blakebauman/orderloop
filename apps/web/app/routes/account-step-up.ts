import { data } from 'react-router';
import { audit } from '~/lib/audit.server';
import { recordStepUp, requireUser, stepUp, stepUpMethod } from '~/lib/auth.server';
import type { Route } from './+types/account-step-up';

/**
 * A step-up for the assistant's confirm cards. `GET` says how this person proves it's them (a
 * code, their password, or single sign-on); `POST` with `{ code }` or `{ password }` checks it, the
 * same as a form's step-up (`stepUp`), and on success records it on this session, which lets the
 * session confirm a sensitive action for the next ten minutes. Someone with only single sign-on
 * confirms at the provider; a POST then passes while that is fresh.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  return { method: await stepUpMethod(me) };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; password?: unknown };
  const given = {
    code: typeof body.code === 'string' ? body.code : undefined,
    password: typeof body.password === 'string' ? body.password : undefined,
  };
  const failed = await stepUp(request, me, given);
  if (failed) {
    await audit(request, 'auth.step_up_failed', {
      actor: me,
      detail: { intent: 'assistant', error: failed },
    });
    return data({ ok: false as const, error: failed }, { status: 403 });
  }
  // A code or password just proved it, so it counts from now. Single sign-on passed only because
  // the provider sign-in is still fresh: its time stays as it was, so it can't be stretched.
  if ((await stepUpMethod(me)) !== 'sso') await recordStepUp(request, me);
  await audit(request, 'auth.stepped_up', { actor: me, detail: { for: 'assistant' } });
  return { ok: true as const };
}
