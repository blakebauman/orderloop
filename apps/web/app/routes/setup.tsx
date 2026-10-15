/**
 * Sets up a deployed workspace: whoever has its setup code creates an admin account with a
 * password they choose and is signed in. The code works once (`setup.server.ts`). With people
 * already on the team, a fresh code is how an admin account is recovered.
 */

import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, startSession, Throttled } from '~/lib/auth.server';
import { redeemSetupCode, setupOpen } from '~/lib/setup.server';
import { TeamError } from '~/lib/team.server';
import type { Route } from './+types/setup';

export const meta = () => [{ title: 'Set up · OrderLoop' }];

/** Lets a throttled attempt's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

export async function loader() {
  return { open: await setupOpen(), team: await authEnabled() };
}

export async function action({ request }: Route.ActionArgs) {
  const f = await request.formData();
  const str = (k: string) => String(f.get(k) ?? '');
  try {
    const id = await redeemSetupCode(request, str('code'), {
      email: str('email'),
      name: str('name'),
      password: str('password'),
    });
    return redirect('/team', { headers: { 'set-cookie': await startSession(request, id) } });
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

export default function Setup() {
  const { open, team } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>()?.error;
  const busy = useNavigation().state === 'submitting';
  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[16vh]">
      <div className="w-full max-w-sm rounded-md border bg-card p-6">
        <Mark className="size-7" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">
          {team ? 'Recover admin access' : 'Set up OrderLoop'}
        </h1>
        {open ? (
          <Form method="post">
            <p className="mt-1 text-muted-foreground text-sm">
              {team
                ? 'Enter the recovery code you were given to create a new admin account.'
                : 'Enter the setup code you were given, and create your admin account. You add the rest of your team after.'}
            </p>
            <label className="mt-5 block text-sm" htmlFor="code">
              Setup code
            </label>
            <Input
              id="code"
              name="code"
              required
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
              className="mt-1 font-mono"
            />
            <label className="mt-3 block text-sm" htmlFor="email">
              Email
            </label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              className="mt-1"
            />
            <label className="mt-3 block text-sm" htmlFor="name">
              Name <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input id="name" name="name" autoComplete="name" className="mt-1" />
            <label className="mt-3 block text-sm" htmlFor="password">
              Password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="mt-1"
              aria-describedby="password-hint"
            />
            <p id="password-hint" className="mt-1.5 text-muted-foreground text-xs">
              At least 10 characters.
            </p>
            {error ? (
              <p className="mt-2 text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="mt-4 w-full" disabled={busy}>
              {busy ? 'Creating…' : 'Create admin account'}
            </Button>
          </Form>
        ) : (
          <p className="mt-1 text-muted-foreground text-sm">
            {team
              ? 'This workspace is set up. Sign in, or ask an admin to add you on the Team page.'
              : 'This workspace isn’t set up yet, and has no setup code. Ask whoever runs it for one.'}
          </p>
        )}
        {team ? (
          <a href="/login" className="mt-4 inline-block text-link text-sm hover:underline">
            Go to sign-in
          </a>
        ) : null}
      </div>
    </main>
  );
}
