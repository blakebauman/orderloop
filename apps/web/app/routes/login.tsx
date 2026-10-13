import { env } from 'cloudflare:workers';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { data, Form, redirect, useActionData, useLoaderData } from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, principal, type SignInResult, signIn, Throttled } from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import type { Route } from './+types/login';

/** Lets a throttled sign-in's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  if (!(await authEnabled()) || (await principal(request))) throw redirect(nextPath(request));
  return { sharedPassword: !!(env as { APP_PASSWORD?: string }).APP_PASSWORD };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');
  let result: SignInResult | null;
  try {
    result = await signIn(request, email, String(form.get('password') ?? ''));
  } catch (err) {
    if (!(err instanceof Throttled)) throw err;
    return data(
      { error: err.message },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  if (!result)
    return {
      error: email.trim()
        ? 'That email and password don’t match an active account.'
        : 'That workspace password is not right.',
    };
  const next = nextPath(request);
  return redirect(result.twoFactor ? `/login/two-factor?next=${encodeURIComponent(next)}` : next, {
    headers: { 'set-cookie': result.cookie },
  });
}

export default function Login() {
  const { sharedPassword } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <Form method="post" className="w-full max-w-sm rounded-md border bg-card p-6">
        <Mark className="size-7" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">OrderLoop</h1>
        <p className="mt-1 text-muted-foreground text-sm">Sign in with your work email.</p>
        <label className="mt-5 block text-sm" htmlFor="email">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoFocus
          autoComplete="username"
          className="mt-1"
          aria-invalid={data?.error ? true : undefined}
        />
        <label className="mt-3 block text-sm" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1"
          aria-invalid={data?.error ? true : undefined}
        />
        {data?.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {data.error}
          </p>
        ) : null}
        <Button type="submit" className="mt-4 w-full">
          Sign in
        </Button>
        {sharedPassword ? (
          <p className="mt-3 text-muted-foreground text-xs">
            Leave the email empty to sign in with the workspace password as an operator.
          </p>
        ) : null}
      </Form>
    </main>
  );
}
