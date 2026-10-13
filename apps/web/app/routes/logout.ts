import { redirect } from 'react-router';
import { signOut } from '~/lib/auth.server';
import type { Route } from './+types/logout';

export async function loader({ request }: Route.LoaderArgs) {
  const headers = new Headers();
  for (const c of await signOut(request)) headers.append('set-cookie', c);
  return redirect('/login', { headers });
}
