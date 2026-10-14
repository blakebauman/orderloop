import { isRole, ROLE_LABELS } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { data, Form, useActionData, useFetcher, useLoaderData } from 'react-router';
import { encode } from 'uqr';
import { Ago } from '~/components/ago';
import { PageHeader, Section } from '~/components/page';
import { audit } from '~/lib/audit.server';
import { requireUser, sessionId } from '~/lib/auth.server';
import { oauthApi } from '~/lib/oauth.server';
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
  const [sessions, twoFactor, grants] = await Promise.all([
    ownSessions(me, await sessionId(request)),
    twoFactorStatus(me),
    oauthApi(request).listUserGrants(me.id),
  ]);
  const apps = grants.items.map((g) => ({
    id: g.id,
    name: String(g.metadata?.app ?? g.clientId),
    role: g.scope.find(isRole) ?? 'viewer',
    createdAt: g.createdAt * 1000,
  }));
  return { me, sessions, twoFactor, apps };
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
        return { ended: 1 };
      case 'end-others':
        return { ended: await endOtherSessions(request, me, current) };
      case 'disconnect-app': {
        const oauth = oauthApi(request);
        const grant = (await oauth.listUserGrants(me.id)).items.find((g) => g.id === str('ref'));
        if (!grant) throw new TeamError('That app is no longer connected.');
        await oauth.revokeGrant(grant.id, me.id);
        await audit(request, 'oauth.app_disconnected', {
          actor: me,
          target: String(grant.metadata?.app ?? grant.clientId),
        });
        return { disconnected: 1 };
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
    await changeOwnPassword(
      request,
      me,
      String(f.get('current') ?? ''),
      String(f.get('next') ?? ''),
    );
    // A new password signs out everywhere else, in case the old one leaked.
    await endOtherSessions(request, me, current);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof TeamError) return data({ error: err.message }, { status: 400 });
    throw err;
  }
}

export default function Account() {
  const { me, sessions, twoFactor, apps } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const end = useFetcher<typeof action>();
  const formatTime = useDateTime();
  const others = sessions.filter((x) => !x.current).length;
  return (
    <>
      <PageHeader title="Account" subtitle={`${me.email ?? me.name} · ${ROLE_LABELS[me.role]}`} />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <div className="max-w-[560px]">
          {me.twoFactorDue ? (
            <p
              role="alert"
              className="mb-6 rounded-md border border-wait/40 bg-wait/10 p-4 text-sm"
            >
              <span className="font-medium">Set up two-factor sign-in to continue.</span> Your role
              needs it in this workspace; the rest of OrderLoop opens once it is on.
            </p>
          ) : null}
          <Section title="Password">
            {me.kind === 'user' ? (
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="password" />
                <label className="block text-sm" htmlFor="current">
                  Current password
                </label>
                <Input
                  id="current"
                  name="current"
                  type="password"
                  required
                  autoComplete="current-password"
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
                />
                <p className="text-muted-foreground text-xs">
                  At least 10 characters, not a common password and not your email address.
                </p>
                {result && 'error' in result ? (
                  <p role="alert" className="text-destructive text-sm">
                    {result.error}
                  </p>
                ) : null}
                {result && 'ok' in result ? (
                  <p role="status" className="text-ok text-sm">
                    Password changed. Your other sessions were signed out.
                  </p>
                ) : null}
                <Button type="submit">Change password</Button>
              </Form>
            ) : (
              <p className="text-muted-foreground text-sm">
                {me.kind === 'open'
                  ? 'Sign-in is off: there is no workspace password and nobody has their own sign-in yet.'
                  : 'You are signed in with the workspace password, which has no account of its own.'}
              </p>
            )}
          </Section>
          {twoFactor ? <TwoFactor status={twoFactor} /> : null}
          {me.kind === 'user' ? (
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
                          <span className="ml-1.5 text-ok text-xs">this browser</span>
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
            </Section>
          ) : null}
          <Section title="Connected apps" className="mt-6" flush>
            {apps.length ? (
              <ul className="divide-y text-sm">
                {apps.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{a.name}</div>
                      <div className="text-muted-foreground text-xs">
                        {ROLE_LABELS[a.role]} · connected {formatTime(a.createdAt)}
                      </div>
                    </div>
                    <end.Form method="post">
                      <input type="hidden" name="intent" value="disconnect-app" />
                      <input type="hidden" name="ref" value={a.id} />
                      <Button size="sm" variant="ghost" disabled={end.state !== 'idle'}>
                        Disconnect
                      </Button>
                    </end.Form>
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
          </Section>
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
  const errorLine = error ? (
    <p role="alert" className="text-destructive text-sm">
      {error}
    </p>
  ) : null;
  return (
    <Section title="Two-factor sign-in" className="mt-6">
      {codes ? (
        <div role="status" className="mb-4 rounded-md border border-wait/40 bg-wait/10 p-4 text-sm">
          <p className="font-medium">Your recovery codes</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Keep them somewhere safe, apart from your phone. Each one signs you in once if you can’t
            use your authenticator app. They are shown once; any older codes no longer work.
          </p>
          <ul className="mt-2 grid select-all grid-cols-2 gap-x-6 gap-y-0.5 rounded-sm bg-card px-3 py-2 font-mono text-sm">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {status.enabledAt ? (
        <tf.Form method="post" className="space-y-3">
          <p className="text-sm">
            <span className="font-medium text-ok">On</span>{' '}
            <span className="text-muted-foreground">
              since {formatTime(status.enabledAt)}. After your password, sign-in asks for a code
              from your authenticator app. {status.recoveryLeft} of 10 recovery codes left.
            </span>
          </p>
          <label className="block text-sm" htmlFor="tf-password">
            Password
          </label>
          <Input
            id="tf-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
          {errorLine}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              name="intent"
              value="two-factor-codes"
              variant="outline"
              disabled={busy}
            >
              New recovery codes
            </Button>
            <Button
              type="submit"
              name="intent"
              value="two-factor-disable"
              variant="ghost"
              disabled={busy}
            >
              Turn off
            </Button>
          </div>
        </tf.Form>
      ) : setup ? (
        <tf.Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="two-factor-enable" />
          <input type="hidden" name="secret" value={setup.secret} />
          <input type="hidden" name="uri" value={setup.uri} />
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
            id="tf-code"
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            className="font-mono"
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
          />
          {errorLine}
          <Button type="submit" disabled={busy}>
            Turn on
          </Button>
        </tf.Form>
      ) : (
        <tf.Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="two-factor-start" />
          <p className="text-muted-foreground text-sm">
            Off. With it on, signing in also needs a 6-digit code from an app on your phone, so a
            leaked password alone can’t get in.
          </p>
          {errorLine}
          <Button type="submit" variant="outline" disabled={busy}>
            Set up two-factor sign-in
          </Button>
        </tf.Form>
      )}
    </Section>
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
