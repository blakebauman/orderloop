import { ROLE_LABELS } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { data, Form, useActionData, useLoaderData } from 'react-router';
import { PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { changeOwnPassword, TeamError } from '~/lib/team.server';
import type { Route } from './+types/account';

export const meta = () => [{ title: 'Account · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  return { me: await requireUser(request) };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const f = await request.formData();
  try {
    await changeOwnPassword(me, String(f.get('current') ?? ''), String(f.get('next') ?? ''));
    return { ok: true as const };
  } catch (err) {
    if (err instanceof TeamError) return data({ error: err.message }, { status: 400 });
    throw err;
  }
}

export default function Account() {
  const { me } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <>
      <PageHeader title="Account" subtitle={`${me.email ?? me.name} · ${ROLE_LABELS[me.role]}`} />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <div className="max-w-[560px]">
          <Section title="Password">
            {me.kind === 'user' ? (
              <Form method="post" className="space-y-3">
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
                    Password changed.
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
        </div>
      </div>
    </>
  );
}
