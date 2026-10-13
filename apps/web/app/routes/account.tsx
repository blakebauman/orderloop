import { ROLE_LABELS } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { data, Form, useActionData, useFetcher, useLoaderData } from 'react-router';
import { Ago } from '~/components/ago';
import { PageHeader, Section } from '~/components/page';
import { requireUser, sessionId } from '~/lib/auth.server';
import {
  changeOwnPassword,
  endOtherSessions,
  endOwnSession,
  ownSessions,
  TeamError,
} from '~/lib/team.server';
import { useDateTime } from '~/lib/use-date-time';
import type { Route } from './+types/account';

export const meta = () => [{ title: 'Account · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  return { me, sessions: await ownSessions(me, await sessionId(request)) };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const f = await request.formData();
  const current = await sessionId(request);
  try {
    switch (String(f.get('intent'))) {
      case 'end-session':
        await endOwnSession(request, me, String(f.get('ref') ?? ''), current);
        return { ended: 1 };
      case 'end-others':
        return { ended: await endOtherSessions(request, me, current) };
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
  const { me, sessions } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const end = useFetcher<typeof action>();
  const formatTime = useDateTime();
  const others = sessions.filter((x) => !x.current).length;
  return (
    <>
      <PageHeader title="Account" subtitle={`${me.email ?? me.name} · ${ROLE_LABELS[me.role]}`} />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <div className="max-w-[560px]">
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
                You are signed in with the workspace password, which has no account of its own.
              </p>
            )}
          </Section>
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
                A session ends 30 days after sign-in, or after 7 days without use.
              </p>
              {end.data && 'error' in end.data ? (
                <p role="alert" className="px-4 pb-2.5 text-destructive text-sm">
                  {end.data.error}
                </p>
              ) : null}
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
