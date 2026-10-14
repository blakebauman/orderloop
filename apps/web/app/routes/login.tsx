import { env } from 'cloudflare:workers';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { useEffect, useRef, useState } from 'react';
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, principal, type SignInResult, signIn, Throttled } from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import { oauthApi } from '~/lib/oauth.server';
import type { Route } from './+types/login';

export const meta = () => [{ title: 'Sign in · OrderLoop' }];

/** Lets a throttled sign-in's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  if (!(await authEnabled()) || (await principal(request))) throw redirect(nextPath(request));
  // Arriving from a consent link: name the app that is waiting (its own, unverified, name).
  const next = nextPath(request);
  let app: string | null = null;
  if (next.startsWith('/oauth/authorize')) {
    const clientId = new URL(next, request.url).searchParams.get('client_id');
    if (clientId) app = (await oauthApi(request).lookupClient(clientId))?.clientName ?? null;
  }
  return { sharedPassword: !!(env as { APP_PASSWORD?: string }).APP_PASSWORD, app };
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
      {
        error: `${err.message}${email.trim() ? ' If you’ve forgotten your password, ask an operator to reset it.' : ''}`,
      },
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
  const { sharedPassword, app } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const busy = useNavigation().state === 'submitting';
  // The workspace password is its own way in, chosen on purpose rather than by leaving the email
  // empty. The server still reads an empty email as the workspace password.
  const [workspace, setWorkspace] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  // A refusal belongs to the way it was made: switching modes clears it.
  const [cleared, setCleared] = useState<typeof result>(undefined);
  const error = result && result !== cleared ? result.error : undefined;
  // After a refusal, the password is ready to retype.
  useEffect(() => {
    if (error) password.current?.select();
  }, [error]);
  // Switching modes puts the cursor where typing goes next.
  const switched = useRef(false);
  useEffect(() => {
    if (switched.current) (workspace ? password : email).current?.focus();
  }, [workspace]);
  const email = useRef<HTMLInputElement>(null);
  const connecting = params.get('next')?.startsWith('/oauth/authorize');
  return (
    // Anchored near the top rather than centred, so the card doesn't jump when the email field
    // comes and goes.
    <main className="grid min-h-dvh justify-items-center bg-background px-4 pt-[16vh]">
      <Form method="post" className="h-fit w-full max-w-sm rounded-md border bg-card p-6">
        {params.get('signed-out') && !error ? (
          <p role="status" className="mb-4 text-muted-foreground text-sm">
            You’ve signed out.
          </p>
        ) : null}
        <Mark className="size-7" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">OrderLoop</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {connecting
            ? app
              ? `Sign in to connect “${app}” to OrderLoop.`
              : 'Sign in to connect an app to OrderLoop.'
            : workspace
              ? 'Sign in with the workspace password.'
              : 'Sign in with your work email.'}
        </p>
        {workspace ? (
          <input type="hidden" name="email" value="" />
        ) : (
          <>
            <label className="mt-5 block text-sm" htmlFor="email">
              Email
            </label>
            <Input
              ref={email}
              id="email"
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="username"
              className="mt-1"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'sign-in-error' : undefined}
            />
          </>
        )}
        <label
          className={workspace ? 'mt-5 block text-sm' : 'mt-3 block text-sm'}
          htmlFor="password"
        >
          {workspace ? 'Workspace password' : 'Password'}
        </label>
        <Input
          // A new field per mode, so a personal password never carries into the workspace one.
          key={workspace ? 'workspace' : 'own'}
          ref={password}
          id="password"
          name="password"
          type="password"
          required
          autoFocus={workspace}
          autoComplete="current-password"
          className="mt-1"
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [workspace ? 'workspace-hint' : '', error ? 'sign-in-error' : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
        />
        {workspace ? (
          <p id="workspace-hint" className="mt-1.5 text-muted-foreground text-xs">
            Signs you in as an operator, without an account of your own.
          </p>
        ) : null}
        {error ? (
          <p id="sign-in-error" className="mt-2 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="mt-4 w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <div className="mt-3 space-y-1.5 text-muted-foreground text-xs">
          {workspace ? null : (
            <p>Forgot your password? Ask an operator to reset it on the Team page.</p>
          )}
          {sharedPassword ? (
            <button
              type="button"
              className="-my-1 inline-flex min-h-8 items-center text-link hover:underline"
              onClick={() => {
                switched.current = true;
                setCleared(result);
                setWorkspace((w) => !w);
              }}
            >
              {workspace ? 'Sign in with your email instead' : 'Use the workspace password instead'}
            </button>
          ) : null}
        </div>
      </Form>
    </main>
  );
}
