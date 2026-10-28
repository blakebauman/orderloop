import { Button } from '@orderloop/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
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
import { Turnstile } from '~/components/turnstile';
import {
  authEnabled,
  principal,
  type SignInResult,
  signIn,
  signInDemo,
  Throttled,
} from '~/lib/auth.server';
import { isDemo } from '~/lib/demo.server';
import { nextPath, withNext } from '~/lib/next-path';
import { oauthApi } from '~/lib/oauth.server';
import { ssoOnlyInEffect } from '~/lib/settings.server';
import { ssoConfig } from '~/lib/sso.server';
import { checkTurnstile, turnstileSiteKey, withTurnstilePolicy } from '~/lib/turnstile.server';
import type { Route } from './+types/login';

export const meta = () => [{ title: 'Sign in · OrderLoop' }];

/**
 * Lets a throttled sign-in's Retry-After reach the response, and the page load Turnstile when the
 * deployment uses it.
 */
export const headers: Route.HeadersFunction = ({ actionHeaders }) =>
  withTurnstilePolicy(actionHeaders);

export async function loader({ request }: Route.LoaderArgs) {
  if (!(await authEnabled()) || (await principal(request))) throw redirect(nextPath(request));
  // Arriving from a consent link: name the app that is waiting (its own, unverified, name).
  const next = nextPath(request);
  let app: string | null = null;
  if (next.startsWith('/oauth/authorize')) {
    const clientId = new URL(next, request.url).searchParams.get('client_id');
    // A registered client's own name only: a URL client id would be fetched (a Client ID Metadata
    // Document), and this page is open to anyone. The consent page looks it up after sign-in.
    if (clientId && !/^https?:/i.test(clientId))
      app =
        (
          await oauthApi(request)
            .lookupClient(clientId)
            .catch(() => null)
        )?.clientName ?? null;
  }
  return {
    app,
    demo: isDemo(),
    sso: !!ssoConfig(),
    ssoOnly: await ssoOnlyInEffect(),
    turnstile: turnstileSiteKey(),
  };
}

/** What the sign-in page says after single sign-on sent someone back without a session. */
const SSO_ERRORS: Record<string, string> = {
  failed: 'Single sign-on didn’t finish. Try again; if it keeps failing, tell an admin.',
  refused:
    'Your identity provider signed you in, but you aren’t on this workspace’s team. Ask an admin to add you.',
  disabled: 'Your account here is disabled. Ask an admin to enable it.',
};

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get('intent') === 'demo' && isDemo())
    return redirect(nextPath(request), { headers: { 'set-cookie': await signInDemo(request) } });
  if (await ssoOnlyInEffect())
    return { error: 'This workspace signs in with single sign-on only. Use the button above.' };
  // Before the password is looked at: a refused attempt costs no hash and locks no one out.
  const refused = await checkTurnstile(request, form, 'login');
  if (refused) return data({ error: refused.error }, { status: refused.status });
  const email = String(form.get('email') ?? '');
  let result: SignInResult | null;
  try {
    result = await signIn(request, email, String(form.get('password') ?? ''));
  } catch (err) {
    if (!(err instanceof Throttled)) throw err;
    return data(
      {
        error: `${err.message} If you’ve forgotten your password, ask an admin to reset it.`,
      },
      { status: 429, headers: { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } },
    );
  }
  if (!result) return { error: 'That email and password don’t match an active account.' };
  const next = nextPath(request);
  return redirect(result.twoFactor ? withNext('/login/two-factor', next) : next, {
    headers: { 'set-cookie': result.cookie },
  });
}

export default function Login() {
  const { app, demo, sso, ssoOnly, turnstile } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const busy = useNavigation().state === 'submitting';
  const password = useRef<HTMLInputElement>(null);
  const passkey = usePasskeySignIn();
  const [checked, setChecked] = useState(false);
  const error = passkey.error ?? result?.error ?? SSO_ERRORS[params.get('sso') ?? ''] ?? undefined;
  const ssoHref = `/login/sso${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`;
  // After a refusal, the password is ready to retype.
  useEffect(() => {
    if (error) password.current?.select();
  }, [error]);
  const connecting = params.get('next')?.startsWith('/oauth/authorize');
  return (
    <main className="grid min-h-dvh content-start justify-items-center gap-4 bg-background px-4 pt-[16vh]">
      {demo && !connecting ? (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>
              <h2 className="font-semibold tracking-title text-2xl">OrderLoop demo</h2>
            </CardTitle>
            <CardDescription>
              A sample workspace with customers, a catalog and stores. Run scenarios, edit flows and
              decide approvals as an operator. It resets every night.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="demo" />
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Opening…' : 'Explore the demo'}
              </Button>
            </Form>
          </CardContent>
        </Card>
      ) : null}
      <Card className="h-fit w-full max-w-sm">
        <CardHeader>
          {params.get('signed-out') && !error ? (
            <p role="status" className="mb-2 text-muted-foreground text-sm">
              You’ve signed out.
            </p>
          ) : null}
          <Mark className="size-7" />
          <CardTitle className="mt-2">
            <h1 className="font-semibold tracking-title text-2xl">OrderLoop</h1>
          </CardTitle>
          <CardDescription>
            {connecting
              ? app
                ? `Sign in to connect “${app}” to OrderLoop.`
                : 'Sign in to connect an app to OrderLoop.'
              : ssoOnly
                ? 'Sign in with your organization’s account.'
                : 'Sign in with your work email.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <FieldGroup className="gap-4">
              {sso ? (
                <Button asChild variant={ssoOnly ? 'default' : 'outline'} className="w-full">
                  <a href={ssoHref}>Sign in with single sign-on</a>
                </Button>
              ) : null}
              {ssoOnly ? (
                error ? (
                  <FieldError id="sign-in-error">{error}</FieldError>
                ) : null
              ) : (
                <>
                  {sso ? (
                    <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                      or with a password
                    </FieldSeparator>
                  ) : null}
                  <Field>
                    <FieldLabel htmlFor="email">Email</FieldLabel>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      required
                      autoFocus={!sso}
                      autoComplete="username"
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? 'sign-in-error' : undefined}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input
                      ref={password}
                      id="password"
                      name="password"
                      type="password"
                      required
                      autoComplete="current-password"
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? 'sign-in-error' : undefined}
                    />
                  </Field>
                  {turnstile ? (
                    <Turnstile
                      siteKey={turnstile}
                      action="login"
                      reset={result}
                      onSolved={setChecked}
                    />
                  ) : null}
                  {error ? <FieldError id="sign-in-error">{error}</FieldError> : null}
                  <Field className="gap-2">
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={busy || passkey.busy || (!!turnstile && !checked)}
                    >
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                    {passkey.supported ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={busy || passkey.busy}
                        onClick={() => void passkey.start(params.toString())}
                      >
                        {passkey.busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
                      </Button>
                    ) : null}
                    <FieldDescription className="text-xs">
                      Forgot your password? Ask an admin to reset it on the Team page.
                    </FieldDescription>
                  </Field>
                </>
              )}
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}

/** Signing in with a passkey: ask the server for a challenge, let the browser answer, check it. */
function usePasskeySignIn() {
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (search: string, body: Record<string, unknown>) => {
    const res = await fetch(`/login/passkey${search ? `?${search}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? 'That did not go through. Try again.'));
    return json;
  };
  const start = async (search: string) => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await call(search, { step: 'options' });
      let response: Awaited<ReturnType<typeof startAuthentication>>;
      try {
        response = await startAuthentication({
          optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
        });
      } catch {
        // The person closed the prompt, or has no passkey here: nothing to report as a failure.
        return;
      }
      const { location } = await call(search, { step: 'verify', response });
      window.location.assign(String(location ?? '/'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { supported, busy, error, start };
}
