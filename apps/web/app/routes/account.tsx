import { isRole, ROLE_LABELS } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  data,
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from 'react-router';
import { encode } from 'uqr';
import { Ago } from '~/components/ago';
import { Confirm } from '~/components/confirm';
import { CopyButton } from '~/components/copy-button';
import { InstallHint } from '~/components/install-hint';
import { PageHeader, Section } from '~/components/page';
import { Passkeys } from '~/components/passkeys';
import { audit } from '~/lib/audit.server';
import { requireUser, sessionId, Throttled } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { oauthApi } from '~/lib/oauth.server';
import { listPasskeys } from '~/lib/passkeys.server';
import { usesPassword } from '~/lib/sso.server';
import {
  changeOwnPassword,
  endOtherSessions,
  endOwnSession,
  ownSessions,
  TeamError,
} from '~/lib/team.server';
import {
  disableTwoFactor,
  enableTwoFactor,
  regenerateRecoveryCodes,
  startSetup,
  twoFactorStatus,
} from '~/lib/two-factor.server';
import { useDateTime } from '~/lib/use-date-time';
import type { Route } from './+types/account';

export const meta = () => [{ title: 'Account · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const [sessions, twoFactor, grants, passkeys, password] = await Promise.all([
    ownSessions(me, await sessionId(request)),
    twoFactorStatus(me),
    oauthApi(request).listUserGrants(me.id),
    me.kind === 'user' ? listPasskeys(me.id) : [],
    me.kind === 'user' ? usesPassword(me.id) : true,
  ]);
  const apps = grants.items.map((g) => ({
    id: g.id,
    name: String(g.metadata?.app ?? g.clientId),
    // Recorded when the app connected; older grants have neither.
    channel: typeof g.metadata?.channel === 'string' ? g.metadata.channel : null,
    host: typeof g.metadata?.host === 'string' ? g.metadata.host : null,
    role: g.scope.find(isRole) ?? 'viewer',
    createdAt: g.createdAt * 1000,
  }));
  return { me, sessions, twoFactor, apps, passkeys, password };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const f = await request.formData();
  const current = await sessionId(request);
  const str = (k: string) => String(f.get(k) ?? '');
  try {
    switch (str('intent')) {
      case 'end-session':
        await endOwnSession(request, me, String(f.get('ref') ?? ''), current);
        return { ended: 1, said: 'Signed out of that session.' };
      case 'end-others': {
        const n = await endOtherSessions(request, me, current);
        return {
          ended: n,
          said: n === 1 ? 'Signed out of 1 other session.' : `Signed out of ${n} other sessions.`,
        };
      }
      case 'disconnect-app': {
        const oauth = oauthApi(request);
        const grant = (await oauth.listUserGrants(me.id)).items.find((g) => g.id === str('ref'));
        if (!grant) throw new TeamError('That app is no longer connected.');
        await oauth.revokeGrant(grant.id, me.id);
        // An A2A app's push configs go with it.
        await engine().dropA2aPushes('user', me.id, [grant.id]);
        await audit(request, 'oauth.app_disconnected', {
          actor: me,
          target: String(grant.metadata?.app ?? grant.clientId),
        });
        return {
          disconnected: 1,
          said: `${String(grant.metadata?.app ?? grant.clientId)} is disconnected.`,
        };
      }
      case 'two-factor-start':
        if (me.kind !== 'user')
          throw new TeamError('Only people with their own sign-in can use two-factor sign-in.');
        return { setup: startSetup(me) };
      case 'two-factor-enable': {
        const setup = { secret: str('secret'), uri: str('uri') };
        try {
          const codes = await enableTwoFactor(request, me, {
            secret: setup.secret,
            code: str('code'),
            password: str('password'),
          });
          return { recoveryCodes: codes };
        } catch (err) {
          // Keep the QR code on screen so the person can try another code.
          if (err instanceof TeamError) return data({ error: err.message, setup }, { status: 400 });
          throw err;
        }
      }
      case 'two-factor-codes':
        return { recoveryCodes: await regenerateRecoveryCodes(request, me, str('password')) };
      case 'two-factor-disable':
        await disableTwoFactor(request, me, str('password'));
        return { disabled: true };
    }
    const apps = await changeOwnPassword(
      request,
      me,
      String(f.get('current') ?? ''),
      String(f.get('next') ?? ''),
    );
    // A new password signs out everywhere else, in case the old one leaked.
    const ended = await endOtherSessions(request, me, current);
    // Replacing a temporary password is the first real sign-in: it gets a welcome, not a notice.
    return { ok: true as const, welcome: !!me.passwordChangeDue, ended, apps };
  } catch (err) {
    if (err instanceof TeamError) return data({ error: err.message }, { status: 400 });
    if (err instanceof Throttled) return data({ error: err.message }, { status: 429 });
    throw err;
  }
}

export default function Account() {
  const { me, sessions, twoFactor, apps, passkeys, password } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const end = useFetcher<typeof action>();
  const formatTime = useDateTime();
  const others = sessions.filter((x) => !x.current).length;
  const passwordError = result && 'error' in result ? result.error : null;
  const welcomeLink = useRef<HTMLAnchorElement>(null);
  const welcomed = !!(result && 'ok' in result && result.welcome);
  useEffect(() => {
    if (welcomed) welcomeLink.current?.focus();
  }, [welcomed]);
  const appsSaid = useRef<HTMLParagraphElement>(null);
  // After a disconnect the row is gone; focus lands on what happened instead of the page top.
  useEffect(() => {
    if (end.data && 'disconnected' in end.data) appsSaid.current?.focus();
  }, [end.data]);
  const changing = useNavigation().state === 'submitting';
  const passwordForm = useRef<HTMLFormElement>(null);
  const changed = result && 'ok' in result;
  // Neither password stays on screen after a change.
  useEffect(() => {
    if (changed) passwordForm.current?.reset();
  }, [changed, result]);
  return (
    <>
      <PageHeader
        title="Account"
        subtitle={`${
          me.kind === 'user' ? (me.email ?? me.name) : 'Sign-in is off'
        } · ${ROLE_LABELS[me.role]}`}
      />
      <div className="mx-auto max-w-page px-4 pb-10 sm:px-6">
        <div className="max-w-[560px]">
          {/* Not alerts: they are there when the page loads, so they're read in order. */}
          {me.passwordChangeDue ? (
            <p className="mb-6 rounded-md border border-wait/40 bg-wait/10 p-4 text-sm">
              <span className="font-medium">Choose your own password to continue.</span> You signed
              in with a temporary password an admin gave you; the rest of OrderLoop opens once you
              replace it.
            </p>
          ) : null}
          {me.twoFactorDue ? (
            <p className="mb-6 rounded-md border border-wait/40 bg-wait/10 p-4 text-sm">
              <span className="font-medium">Set up two-factor sign-in to continue.</span> Your role
              needs it in this workspace; the rest of OrderLoop opens once it is on.
            </p>
          ) : null}
          {result && 'ok' in result && result.welcome ? (
            <div role="status" className="mb-6 card p-4">
              <p className="font-medium">Your password is set. OrderLoop is open.</p>
              <p className="mt-1 text-muted-foreground text-sm">
                You’re {/^[aeiou]/i.test(ROLE_LABELS[me.role]) ? 'an' : 'a'} {ROLE_LABELS[me.role]}.
                Two-factor sign-in, where you’re signed in and connected apps are below.
              </p>
              <Button asChild size="sm" className="mt-3">
                <Link to="/" ref={welcomeLink}>
                  Go to the overview
                </Link>
              </Button>
            </div>
          ) : null}
          {me.passwordChangeDue || me.twoFactorDue ? null : <InstallHint />}
          <Section title={password ? 'Password' : 'Sign-in'}>
            {me.kind === 'user' && !password ? (
              <p className="text-muted-foreground text-sm">
                You sign in with single sign-on. Your organization’s identity provider looks after
                your password and two-factor sign-in.
              </p>
            ) : me.kind === 'user' ? (
              <Form method="post" className="space-y-3" ref={passwordForm}>
                <input type="hidden" name="intent" value="password" />
                {/* Lets a password manager save the new password against this account. */}
                <input
                  type="email"
                  name="username"
                  autoComplete="username"
                  value={me.email ?? ''}
                  readOnly
                  hidden
                />
                <label className="block text-sm" htmlFor="current">
                  {me.passwordChangeDue
                    ? 'The temporary password you just used'
                    : 'Current password'}
                </label>
                <Input
                  id="current"
                  name="current"
                  type="password"
                  required
                  autoComplete="current-password"
                  autoFocus={me.passwordChangeDue}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={passwordError ? 'password-error' : undefined}
                />
                <label className="block text-sm" htmlFor="next">
                  New password
                </label>
                <Input
                  id="next"
                  name="next"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                  aria-describedby={`password-hint${passwordError ? ' password-error' : ''}`}
                />
                <p id="password-hint" className="text-muted-foreground text-xs">
                  At least 10 characters, not a common password and not your email address.
                </p>
                {passwordError ? (
                  <p id="password-error" role="alert" className="text-destructive text-sm">
                    {passwordError}
                  </p>
                ) : null}
                {result && 'ok' in result && !result.welcome ? (
                  <p role="status" className="text-sm">
                    Password changed.
                    {result.ended
                      ? ` ${result.ended === 1 ? 'Your other session was' : 'Your other sessions were'} signed out.`
                      : ''}
                    {result.apps
                      ? ` ${result.apps === 1 ? 'Your connected app was' : 'Your connected apps were'} disconnected; connect again to keep using them.`
                      : ''}
                  </p>
                ) : null}
                <Button type="submit" disabled={changing}>
                  {changing
                    ? 'Changing…'
                    : me.passwordChangeDue
                      ? 'Set my password'
                      : 'Change password'}
                </Button>
              </Form>
            ) : (
              <p className="text-muted-foreground text-sm">
                Sign-in is off: nobody has an account yet.{' '}
                <Link to="/team" className="text-link hover:underline">
                  Turn it on from the Team page
                </Link>
                .
              </p>
            )}
          </Section>
          {password && twoFactor && (!me.passwordChangeDue || me.twoFactorDue) ? (
            <TwoFactor status={twoFactor} />
          ) : null}
          {me.kind === 'user' && password && !me.passwordChangeDue ? (
            <Passkeys passkeys={passkeys} />
          ) : null}
          {me.kind === 'user' && !me.passwordChangeDue ? (
            <Section
              title="Where you're signed in"
              className="mt-6"
              flush
              actions={
                others ? (
                  <end.Form method="post">
                    <input type="hidden" name="intent" value="end-others" />
                    <Button size="sm" variant="outline" disabled={end.state !== 'idle'}>
                      Sign out everywhere else
                    </Button>
                  </end.Form>
                ) : undefined
              }
            >
              <ul className="divide-y text-sm">
                {sessions.map((x) => (
                  <li key={x.ref} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div>
                        {x.device}
                        {x.current ? (
                          <span className="ml-1.5 font-medium text-xs">· this browser</span>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {x.ip ? <span className="font-mono">{x.ip}</span> : null}
                        {x.ip ? ' · ' : ''}signed in {formatTime(x.createdAt)}
                        {x.current ? null : (
                          <>
                            {' '}
                            · active <Ago ms={x.lastSeenAt} />
                          </>
                        )}
                      </div>
                    </div>
                    {x.current ? null : (
                      <end.Form method="post">
                        <input type="hidden" name="intent" value="end-session" />
                        <input type="hidden" name="ref" value={x.ref} />
                        <Button size="sm" variant="ghost" disabled={end.state !== 'idle'}>
                          Sign out
                        </Button>
                      </end.Form>
                    )}
                  </li>
                ))}
              </ul>
              <p className="border-t px-4 py-2.5 text-muted-foreground text-xs">
                <span className="block max-w-[75ch]">
                  A session ends 30 days after sign-in, or after 7 days without use.
                </span>
              </p>
              {end.data && 'error' in end.data ? (
                <p role="alert" className="px-4 pb-2.5 text-destructive text-sm">
                  {end.data.error}
                </p>
              ) : null}
              {end.data && 'ended' in end.data ? (
                <p role="status" className="border-t px-4 py-2.5 text-sm">
                  {end.data.said}
                </p>
              ) : null}
            </Section>
          ) : null}
          {me.passwordChangeDue ? null : (
            <Section title="Connected apps" className="mt-6" flush>
              {apps.length ? (
                <ul className="divide-y text-sm">
                  {apps.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{a.name}</div>
                        <div className="text-muted-foreground text-xs">
                          {a.channel
                            ? `${a.channel === 'A2A' ? 'Agent (A2A)' : 'AI client (MCP)'} · `
                            : ''}
                          {a.host ? <span className="font-mono">{a.host}</span> : null}
                          {a.host ? ' · ' : ''}
                          acts as {ROLE_LABELS[a.role]} · connected {formatTime(a.createdAt)}
                        </div>
                      </div>
                      <Disconnect app={a.name} id={a.id} end={end} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-2.5 text-muted-foreground text-sm">
                  No apps are connected. MCP clients such as Claude connect at{' '}
                  <code className="font-mono">/mcp</code>, and A2A agents at{' '}
                  <code className="font-mono">/a2a</code>; each asks you here to approve it.
                </p>
              )}
              {end.data && 'disconnected' in end.data ? (
                <p
                  ref={appsSaid}
                  tabIndex={-1}
                  role="status"
                  className="border-t px-4 py-2.5 text-sm outline-none"
                >
                  {end.data.said}
                </p>
              ) : null}
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function TwoFactor({ status }: { status: { enabledAt: number | null; recoveryLeft: number } }) {
  const tf = useFetcher<typeof action>();
  const formatTime = useDateTime();
  const busy = tf.state !== 'idle';
  const d = tf.data;
  const error = d && 'error' in d ? d.error : null;
  const setup = d && 'setup' in d ? d.setup : null;
  const codes = d && 'recoveryCodes' in d ? d.recoveryCodes : null;
  // Which form the last error belongs to, so it shows beside that form.
  const [lastIntent, setLastIntent] = useState<string | null>(null);
  const [savedCodes, setSavedCodes] = useState<string | null>(null);
  const [cancelledSetup, setCancelledSetup] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const codesKey = codes?.join(',') ?? null;
  const showCodes = codes && savedCodes !== codesKey;
  const showSetup = setup && cancelledSetup !== setup.secret && !status.enabledAt;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // A new step takes focus, so nobody is left at the top of the page.
  useEffect(() => {
    if (showCodes || showSetup) headingRef.current?.focus();
  }, [showCodes, showSetup]);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const turnOff = useRef<HTMLButtonElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const saved = useRef(false);
  // Leaving the codes step lands on the status it leads to, not the top of the page.
  useEffect(() => {
    if (!showCodes && saved.current) {
      saved.current = false;
      statusLine.current?.focus();
    }
  }, [showCodes]);
  // A refused setup code is ready to retype.
  useEffect(() => {
    if (error && lastIntent === 'two-factor-enable' && /code/i.test(error))
      codeField.current?.select();
  }, [error, lastIntent]);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    const intent = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    setLastIntent(intent ?? new FormData(e.currentTarget).get('intent')?.toString() ?? null);
  };
  const errorFor = (intent: string) =>
    error && lastIntent === intent ? (
      <p id={`${intent}-error`} role="alert" className="text-destructive text-sm">
        {error}
      </p>
    ) : null;

  if (showCodes) {
    const text = codes.join('\n');
    return (
      <Section title="Two-factor sign-in" className="mt-6">
        <div className="space-y-3">
          <h3 ref={headingRef} tabIndex={-1} className="font-medium text-sm outline-none">
            {status.enabledAt && lastIntent === 'two-factor-codes'
              ? 'New recovery codes'
              : 'Two-factor sign-in is on. Save your recovery codes.'}
          </h3>
          <p className="text-muted-foreground text-sm">
            Each one signs you in once if you can’t use your authenticator app. Keep them apart from
            your phone. They are shown only now
            {lastIntent === 'two-factor-codes' ? '; your older codes no longer work.' : '.'}
          </p>
          <ul
            aria-label="Recovery codes"
            className="grid select-all grid-cols-2 gap-x-6 gap-y-0.5 rounded-sm border bg-card px-3 py-2 font-mono text-sm"
          >
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={text} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'orderloop-recovery-codes.txt';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download /> Download
            </Button>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setSavedCodes(codesKey);
                saved.current = true;
              }}
            >
              I’ve saved them
            </Button>
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Two-factor sign-in" className="mt-6">
      {status.enabledAt ? (
        <div className="space-y-5">
          {/* A state, not a success: ink, not green. */}
          <p ref={statusLine} tabIndex={-1} className="text-sm outline-none">
            <span className="font-medium">On</span>{' '}
            <span className="text-muted-foreground">
              since {formatTime(status.enabledAt)}. After your password, sign-in asks for a code
              from your authenticator app.
            </span>{' '}
            <span
              className={cn(
                status.recoveryLeft <= 3 ? 'font-medium text-wait' : 'text-muted-foreground',
              )}
            >
              {status.recoveryLeft} of 10 recovery codes left
              {status.recoveryLeft <= 3 ? '; make new ones soon.' : '.'}
            </span>
          </p>
          <tf.Form method="post" className="space-y-2" onSubmit={submit}>
            <input type="hidden" name="intent" value="two-factor-codes" />
            <h3 className="font-medium text-sm">New recovery codes</h3>
            <p className="text-muted-foreground text-xs">
              Replaces your codes; the old ones stop working.
            </p>
            <label className="block text-sm" htmlFor="tf-codes-password">
              Your password, to make new codes
            </label>
            <Input
              id="tf-codes-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              aria-describedby={errorFor('two-factor-codes') ? 'two-factor-codes-error' : undefined}
            />
            {errorFor('two-factor-codes')}
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              Make new codes
            </Button>
          </tf.Form>
          <tf.Form method="post" className="space-y-2 border-t pt-4" onSubmit={submit}>
            <input type="hidden" name="intent" value="two-factor-disable" />
            <h3 className="font-medium text-sm">Turn off two-factor sign-in</h3>
            {confirmOff ? (
              <>
                <p className="text-sm">
                  Sign-in will need only your password. If your role requires two-factor sign-in,
                  you’ll be asked to set it up again.
                </p>
                <label className="block text-sm" htmlFor="tf-off-password">
                  Your password, to turn it off
                </label>
                <Input
                  id="tf-off-password"
                  name="password"
                  type="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  aria-describedby={
                    errorFor('two-factor-disable') ? 'two-factor-disable-error' : undefined
                  }
                />
                {errorFor('two-factor-disable')}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="destructive" size="sm" disabled={busy}>
                    Turn off
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirmOff(false);
                      requestAnimationFrame(() => turnOff.current?.focus());
                    }}
                  >
                    Keep it on
                  </Button>
                </div>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-bad hover:text-bad"
                ref={turnOff}
                onClick={() => setConfirmOff(true)}
              >
                Turn off…
              </Button>
            )}
          </tf.Form>
        </div>
      ) : showSetup ? (
        <tf.Form method="post" className="space-y-3" onSubmit={submit}>
          <input type="hidden" name="intent" value="two-factor-enable" />
          <input type="hidden" name="secret" value={setup.secret} />
          <input type="hidden" name="uri" value={setup.uri} />
          <h3 ref={headingRef} tabIndex={-1} className="font-medium text-sm outline-none">
            Set up your authenticator app
          </h3>
          <p className="text-sm">
            Scan this with an authenticator app (1Password, Google Authenticator, Authy and others),
            then enter the code it shows.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <QrCode value={setup.uri} />
            <div className="min-w-0 text-xs">
              <p className="text-muted-foreground">Can’t scan? Enter this key in the app:</p>
              <code className="mt-1 block select-all break-all font-mono text-sm">
                {setup.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
            </div>
          </div>
          <label className="block text-sm" htmlFor="tf-code">
            Code from the app
          </label>
          <Input
            ref={codeField}
            id="tf-code"
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            className="font-mono"
            aria-invalid={
              error && lastIntent === 'two-factor-enable' && /code/i.test(error) ? true : undefined
            }
            aria-describedby={errorFor('two-factor-enable') ? 'two-factor-enable-error' : undefined}
          />
          <label className="block text-sm" htmlFor="tf-password">
            Your password
          </label>
          <Input
            id="tf-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            aria-invalid={
              error && lastIntent === 'two-factor-enable' && /password/i.test(error)
                ? true
                : undefined
            }
            aria-describedby={errorFor('two-factor-enable') ? 'two-factor-enable-error' : undefined}
          />
          {errorFor('two-factor-enable')}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Turning on…' : 'Turn on'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCancelledSetup(setup.secret)}>
              Cancel
            </Button>
          </div>
        </tf.Form>
      ) : (
        <tf.Form method="post" className="space-y-3" onSubmit={submit}>
          <input type="hidden" name="intent" value="two-factor-start" />
          <p className="text-muted-foreground text-sm">
            Off. With it on, signing in also needs a 6-digit code from an app on your phone, so a
            leaked password alone can’t get in.
          </p>
          {errorFor('two-factor-start')}
          <Button type="submit" variant="outline" disabled={busy}>
            Set up two-factor sign-in
          </Button>
        </tf.Form>
      )}
    </Section>
  );
}

/** Disconnecting an app ends its access at once; confirm in place first. */
function Disconnect({
  app,
  id,
  end,
}: {
  app: string;
  id: string;
  end: ReturnType<typeof useFetcher<typeof action>>;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const keep = () => {
    setConfirming(false);
    // Back to where the person was.
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        aria-expanded={confirming}
        onClick={() => setConfirming(true)}
      >
        Disconnect
      </Button>
      {/* Its own line under the row, so the app it names stays readable beside the question. */}
      {confirming ? (
        <end.Form
          method="post"
          className="flex basis-full flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
        >
          <input type="hidden" name="intent" value="disconnect-app" />
          <input type="hidden" name="ref" value={id} />
          <Confirm
            message={`Disconnect ${app}?`}
            note="It loses access now."
            cancelLabel="Keep"
            onCancel={keep}
            className="flex-1"
          >
            <Button size="sm" variant="destructive" disabled={end.state !== 'idle'}>
              Disconnect
            </Button>
          </Confirm>
        </end.Form>
      ) : null}
    </>
  );
}

/** Dark modules on a white field whatever the theme, which is what scanners expect. */
function QrCode({ value }: { value: string }) {
  const { data: rows, size } = encode(value, { ecc: 'M', border: 2 });
  let path = '';
  rows.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="size-40 shrink-0 rounded-sm"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for your authenticator app"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
