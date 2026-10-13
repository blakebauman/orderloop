import { redirect } from 'react-router';
import { signOutCookie } from '~/lib/auth.server';

export function loader() {
  return redirect('/login', { headers: { 'set-cookie': signOutCookie } });
}
