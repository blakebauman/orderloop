import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { useEffect, useRef, useState } from 'react';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
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
      error:
        form.get('method') === 'recovery'
          ? 'That recovery code isn’t one of yours, or it has been used.'
          : 'That code is not right. Check the time on your phone, or use a recovery code.',
    };
  }
  const headers = new Headers();
  for (const c of cookies) headers.append('set-cookie', c);
  return redirect(nextPath(request), { headers });
}

export default function LoginTwoFactor() {
  const { email } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  // Authenticator codes are digits (a number keypad on phones); recovery codes have letters.
  const [recovery, setRecovery] = useState(false);
  const code = useRef<HTMLInputElement>(null);
  const [cleared, setCleared] = useState<typeof result>(undefined);
  const error = result && result !== cleared ? result.error : undefined;
  useEffect(() => {
    if (error) code.current?.select();
  }, [error]);
  return (
    <main className="grid min-h-dvh justify-items-center bg-background px-4 pt-[16vh]">
      <Form method="post" className="h-fit w-full max-w-sm card p-6">
        <Mark className="size-7" />
        <h1 className="mt-4 font-semibold tracking-title text-2xl">Two-factor sign-in</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {recovery
            ? `Enter one of your recovery codes for ${email}. Each works once.`
            : `Enter the 6-digit code from your authenticator app for ${email}.`}
        </p>
        <label className="mt-5 block text-sm" htmlFor="code">
          {recovery ? 'Recovery code' : 'Code'}
        </label>
        <input type="hidden" name="method" value={recovery ? 'recovery' : 'app'} />
        <Input
          ref={code}
          key={recovery ? 'recovery' : 'app'}
          id="code"
          name="code"
          required
          autoFocus
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete={recovery ? 'off' : 'one-time-code'}
          spellCheck={false}
          className="mt-1 font-mono"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'code-error' : undefined}
        />
        {error ? (
          <p id="code-error" className="mt-2 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="mt-4 w-full" disabled={busy}>
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
        <div className="mt-3 space-y-1.5 text-muted-foreground text-xs">
          <button
            type="button"
            className="-my-1 inline-flex min-h-8 items-center text-link hover:underline"
            onClick={() => {
              setCleared(result);
              setRecovery((r) => !r);
            }}
          >
            {recovery ? 'Use a code from your app instead' : 'Lost your phone? Use a recovery code'}
          </button>
          <p>No codes left? Ask an admin to reset your two-factor sign-in.</p>
          <button
            type="submit"
            form="different-account"
            className="-my-1 inline-flex min-h-8 items-center text-link hover:underline"
          >
            Use a different account
          </button>
        </div>
      </Form>
      {/* Outside the code form: it signs out, which ends the challenge too. */}
      <form id="different-account" method="post" action="/logout" hidden />
    </main>
  );
}
