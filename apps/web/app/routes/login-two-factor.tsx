import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { data, Form, Link, redirect, useActionData, useLoaderData } from 'react-router';
import { Mark } from '~/components/mark';
import {
  clearChallengeCookie,
  pendingChallenge,
  principal,
  Throttled,
  verifySecondFactor,
} from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import type { Route } from './+types/login-two-factor';

export const meta = () => [{ title: 'Two-factor sign-in · OrderLoop' }];

/** Lets a throttled attempt's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

const backToSignIn = (request: Request) =>
  redirect(`/login?next=${encodeURIComponent(nextPath(request))}`, {
    headers: { 'set-cookie': clearChallengeCookie },
  });

export async function loader({ request }: Route.LoaderArgs) {
  if (await principal(request)) throw redirect(nextPath(request));
  const pending = await pendingChallenge(request);
  if (!pending) throw backToSignIn(request);
  return { email: pending.email };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  let cookies: string[] | null;
  try {
    cookies = await verifySecondFactor(request, String(form.get('code') ?? ''));
  } catch (err) {
    if (!(err instanceof Throttled)) throw err;
    return data(
      { error: err.message },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  if (!cookies) {
    // The ten minutes ran out, or the person was disabled meanwhile: start again.
    if (!(await pendingChallenge(request))) throw backToSignIn(request);
    return {
      error: 'That code is not right. Check the time on your phone, or use a recovery code.',
    };
  }
  const headers = new Headers();
  for (const c of cookies) headers.append('set-cookie', c);
  return redirect(nextPath(request), { headers });
}

export default function LoginTwoFactor() {
  const { email } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <Form method="post" className="w-full max-w-sm rounded-md border bg-card p-6">
        <Mark className="size-7" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">Two-factor sign-in</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Enter the 6-digit code from your authenticator app for {email}.
        </p>
        <label className="mt-5 block text-sm" htmlFor="code">
          Code
        </label>
        <Input
          id="code"
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          className="mt-1 font-mono"
          aria-invalid={result?.error ? true : undefined}
          aria-describedby="code-hint"
        />
        <p id="code-hint" className="mt-1.5 text-muted-foreground text-xs">
          Lost your phone? Enter one of your recovery codes instead. Each works once.
        </p>
        {result?.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {result.error}
          </p>
        ) : null}
        <Button type="submit" className="mt-4 w-full">
          Verify
        </Button>
        <p className="mt-3 text-muted-foreground text-xs">
          No codes left? Ask an operator to reset your two-factor sign-in.{' '}
          <Link to="/logout" className="text-link hover:underline">
            Start over
          </Link>
        </p>
      </Form>
    </main>
  );
}
