import { redirect } from 'react-router';
import { signOut } from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import type { Route } from './+types/logout';

export async function loader({ request }: Route.LoaderArgs) {
  const headers = new Headers();
  for (const c of await signOut(request)) headers.append('set-cookie', c);
  // "Not you?" on the consent page signs out and comes back to it as someone else.
  const next = nextPath(request);
  const to = new URLSearchParams({ 'signed-out': '1' });
  if (next !== '/') to.set('next', next);
  return redirect(`/login?${to}`, { headers });
}
