/**
 * Sets up a deployed workspace: whoever has its setup code creates an admin account with a
 * password they choose and is signed in. The code works once (`setup.server.ts`). With people
 * already on the team, a fresh code is how an admin account is recovered.
 */

import { Button } from '@orderloop/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { useState } from 'react';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Mark } from '~/components/mark';
import { Turnstile } from '~/components/turnstile';
import { authEnabled, startSession, Throttled } from '~/lib/auth.server';
import { redeemSetupCode, setupOpen } from '~/lib/setup.server';
import { TeamError } from '~/lib/team.server';
import { checkTurnstile, turnstileSiteKey, withTurnstilePolicy } from '~/lib/turnstile.server';
import type { Route } from './+types/setup';

export const meta = () => [{ title: 'Set up · OrderLoop' }];

/**
 * Lets a throttled attempt's Retry-After reach the response, and the page load Turnstile when the
 * deployment uses it.
 */
export const headers: Route.HeadersFunction = ({ actionHeaders }) =>
  withTurnstilePolicy(actionHeaders);

export async function loader() {
  return { open: await setupOpen(), team: await authEnabled(), turnstile: turnstileSiteKey() };
}

export async function action({ request }: Route.ActionArgs) {
  const f = await request.formData();
  // Before the code is looked at: a bot racing a new deployment's first admin gets nowhere.
  const refused = await checkTurnstile(request, f, 'setup');
  if (refused) return data({ error: refused.error }, { status: refused.status });
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
  const { open, team, turnstile } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const error = result?.error;
  const busy = useNavigation().state === 'submitting';
  const [checked, setChecked] = useState(false);
  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[16vh]">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Mark className="size-7" />
          <CardTitle className="mt-2">
            <h1 className="font-semibold tracking-title text-2xl">
              {team ? 'Recover admin access' : 'Set up OrderLoop'}
            </h1>
          </CardTitle>
          <CardDescription>
            {open
              ? team
                ? 'Enter the recovery code you were given to create a new admin account.'
                : 'Enter the setup code you were given, and create your admin account. You add the rest of your team after.'
              : team
                ? 'This workspace is set up. Sign in, or ask an admin to add you on the Team page.'
                : 'This workspace isn’t set up yet, and has no setup code. Ask whoever runs it for one.'}
          </CardDescription>
        </CardHeader>
        {open || team ? (
          <CardContent>
            {open ? (
              <Form method="post">
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="code">Setup code</FieldLabel>
                    <Input
                      id="code"
                      name="code"
                      required
                      autoFocus
                      autoComplete="one-time-code"
                      spellCheck={false}
                      className="font-mono"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="email">Email</FieldLabel>
                    <Input id="email" name="email" type="email" required autoComplete="username" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="name">
                      Name <span className="font-normal text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Input id="name" name="name" autoComplete="name" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      required
                      minLength={10}
                      autoComplete="new-password"
                      aria-describedby="password-hint"
                    />
                    <FieldDescription id="password-hint" className="text-xs">
                      At least 10 characters.
                    </FieldDescription>
                  </Field>
                  {turnstile ? (
                    <Turnstile
                      siteKey={turnstile}
                      action="setup"
                      reset={result}
                      onSolved={setChecked}
                    />
                  ) : null}
                  {error ? <FieldError>{error}</FieldError> : null}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={busy || (!!turnstile && !checked)}
                  >
                    {busy ? 'Creating…' : 'Create admin account'}
                  </Button>
                </FieldGroup>
              </Form>
            ) : null}
            {team ? (
              <a
                href="/login"
                className={`${open ? 'mt-4 ' : ''}inline-block text-link text-sm hover:underline`}
              >
                Go to sign-in
              </a>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
    </main>
  );
}
