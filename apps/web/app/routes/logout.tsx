import { Button } from '@orderloop/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@orderloop/ui/card';
import { Form, redirect, useLoaderData } from 'react-router';
import { Mark } from '~/components/mark';
import { principal, signOut } from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import type { Route } from './+types/logout';

export const meta = () => [{ title: 'Sign out · OrderLoop' }];

/** Where signing out lands: the sign-in page, carrying `next` (the consent page's "Not you?"). */
function toSignIn(request: Request) {
  const next = nextPath(request);
  const to = new URLSearchParams({ 'signed-out': '1' });
  if (next !== '/') to.set('next', next);
  return `/login?${to}`;
}

/**
 * Signing out is a POST, so the origin check covers it and no link or image on another site can
 * sign someone out. A GET (an old bookmark, a typed address) asks first.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const me = await principal(request);
  if (!me || me.kind === 'open') throw redirect(toSignIn(request));
  return { who: me.email ?? me.name };
}

export async function action({ request }: Route.ActionArgs) {
  const headers = new Headers();
  for (const c of await signOut(request)) headers.append('set-cookie', c);
  return redirect(toSignIn(request), { headers });
}

export default function Logout() {
  const { who } = useLoaderData<typeof loader>();
  return (
    <main className="grid min-h-dvh justify-items-center bg-background px-4 pt-[16vh]">
      <Card className="h-fit w-full max-w-sm">
        <Form method="post" reloadDocument className="contents">
          <CardHeader>
            <Mark className="size-7" />
            <CardTitle className="mt-2">
              <h1 className="font-semibold tracking-title text-2xl">Sign out?</h1>
            </CardTitle>
            <CardDescription>You’re signed in as {who}.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="submit" className="w-full">
              Sign out
            </Button>
          </CardFooter>
        </Form>
      </Card>
    </main>
  );
}
