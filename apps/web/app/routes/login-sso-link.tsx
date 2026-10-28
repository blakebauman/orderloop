import type { Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { useEffect, useRef } from 'react';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';
import { Mark } from '~/components/mark';
import { audit } from '~/lib/audit.server';
import { principal, signInToLink, Throttled } from '~/lib/auth.server';
import { nextPath } from '~/lib/next-path';
import { clearLinkCookie, finishSsoLink, LINK_PATH, pendingSsoLink } from '~/lib/sso.server';
import type { Route } from './+types/login-sso-link';

export const meta = () => [{ title: 'Link single sign-on · OrderLoop' }];

/** Lets a throttled attempt's Retry-After reach the response. */
export const headers: Route.HeadersFunction = ({ actionHeaders }) => actionHeaders;

const startAgain = () =>
  redirect('/login?sso=failed', { headers: { 'set-cookie': clearLinkCookie } });

const refused = (request: Request, email: string) =>
  audit(request, 'auth.sign_in_failed', {
    target: email,
    detail: { reason: 'SSO link refused', method: 'sso' },
  });

/**
 * Single sign-on found someone on the team by email who signs in with a password. Before the
 * identity is linked to that account, they sign in with its password here (then their code, on
 * the two-factor page, which sends them back): linked, they go where they were going. Without
 * two-factor sign-in the link comes first, and the session only once it worked.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const pending = await pendingSsoLink(request);
  const caller = await principal(request);
  if (caller) {
    if (pending && !(await finishSsoLink(request, caller)))
      await refused(request, pending.user.email);
    throw redirect(nextPath(request), { headers: { 'set-cookie': clearLinkCookie } });
  }
  if (!pending) throw startAgain();
  return { email: pending.user.email };
}

export async function action({ request }: Route.ActionArgs) {
  const pending = await pendingSsoLink(request);
  if (!pending) throw startAgain();
  const form = await request.formData();
  let result: Awaited<ReturnType<typeof signInToLink>>;
  try {
    result = await signInToLink(request, pending.user, String(form.get('password') ?? ''));
  } catch (err) {
    if (!(err instanceof Throttled)) throw err;
    return data(
      { error: `${err.message} If you’ve forgotten your password, ask an admin to reset it.` },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  if (!result) return { error: 'That password isn’t right for this account.' };
  if (result.twoFactor) {
    const back = `${LINK_PATH}?next=${encodeURIComponent(nextPath(request))}`;
    return redirect(`/login/two-factor?next=${encodeURIComponent(back)}`, {
      headers: { 'set-cookie': result.cookie },
    });
  }
  const { user } = pending;
  const person = { kind: 'user', id: user.id, email: user.email, name: user.name } as const;
  if (!(await finishSsoLink(request, { ...person, role: user.role as Role }))) {
    await refused(request, user.email);
    throw startAgain();
  }
  const headers = new Headers({ 'set-cookie': await result.signIn() });
  headers.append('set-cookie', clearLinkCookie);
  return redirect(nextPath(request), { headers });
}

export default function LoginSsoLink() {
  const { email } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const password = useRef<HTMLInputElement>(null);
  const error = result?.error;
  useEffect(() => {
    if (error) password.current?.select();
  }, [error]);
  return (
    <main className="grid min-h-dvh justify-items-center bg-background px-4 pt-[16vh]">
      <Card className="h-fit w-full max-w-sm">
        <CardHeader>
          <Mark className="size-7" />
          <CardTitle className="mt-2">
            <h1 className="font-semibold tracking-title text-2xl">Link single sign-on</h1>
          </CardTitle>
          <CardDescription>
            Your identity provider signed you in as {email}, which already has a password here.
            Enter it once to link the two; after that, single sign-on is enough.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            {/* For password managers: the account this password belongs to. */}
            <input type="hidden" name="email" autoComplete="username" value={email} />
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  ref={password}
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'password-error' : undefined}
                />
                {error ? <FieldError id="password-error">{error}</FieldError> : null}
              </Field>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Checking…' : 'Link and sign in'}
              </Button>
              <div className="space-y-1.5 text-muted-foreground text-xs">
                <p>Forgot your password? Ask an admin to reset it on the Team page.</p>
                <Link
                  to="/login"
                  className="-my-1 inline-flex min-h-8 items-center text-link hover:underline"
                >
                  Back to sign-in
                </Link>
              </div>
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}
