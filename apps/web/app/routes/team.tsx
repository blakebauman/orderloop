import { ROLE_LABELS, ROLES, type Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { data, Form, Link, redirect, useActionData, useFetcher, useLoaderData } from 'react-router';
import { Ago } from '~/components/ago';
import { Empty, PageHeader, Section } from '~/components/page';
import { requireUser, startSession } from '~/lib/auth.server';
import {
  addUser,
  createFirstOperator,
  createToken,
  listTeam,
  resetPassword,
  revokeToken,
  setDisabled,
  setRole,
  TeamError,
} from '~/lib/team.server';
import type { Route } from './+types/team';

export const meta = () => [{ title: 'Team · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'operator');
  return { ...(await listTeam()), me };
}

/** One-time secrets come back from the action and are shown once, never stored in the clear. */
type Secret = { label: string; value: string };

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const f = await request.formData();
  const str = (k: string) => String(f.get(k) ?? '');
  try {
    if (str('intent') === 'first-operator') {
      if (me.kind !== 'open') throw new TeamError('The team already has people.');
      const id = await createFirstOperator(request, {
        email: str('email'),
        name: str('name'),
        password: str('password'),
      });
      return redirect('/team', { headers: { 'set-cookie': await startSession(id) } });
    }
    switch (str('intent')) {
      case 'add-user': {
        if (me.kind === 'open')
          throw new TeamError(
            'Create your own operator account first; adding people turns on sign-in.',
          );
        const r = await addUser(request, me, {
          email: str('email'),
          name: str('name'),
          role: str('role'),
        });
        return { secret: { label: `Password for ${r.email}`, value: r.password } as Secret };
      }
      case 'role':
        await setRole(request, me, str('id'), str('role'));
        return { ok: true };
      case 'reset': {
        const r = await resetPassword(request, me, str('id'));
        return { secret: { label: `New password for ${r.email}`, value: r.password } as Secret };
      }
      case 'disable':
      case 'enable':
        await setDisabled(request, me, str('id'), str('intent') === 'disable');
        return { ok: true };
      case 'add-token': {
        const r = await createToken(request, me, { name: str('name'), role: str('role') });
        return { secret: { label: `API token “${r.name}”`, value: r.token } as Secret };
      }
      case 'revoke':
        await revokeToken(request, me, str('id'));
        return { ok: true };
    }
    return data({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    if (err instanceof TeamError) return data({ error: err.message }, { status: 400 });
    throw err;
  }
}

function RoleSelect({ name = 'role', value }: { name?: string; value?: string }) {
  return (
    <NativeSelect name={name} defaultValue={value ?? 'viewer'} className="h-8">
      {ROLES.map((r) => (
        <NativeSelectOption key={r} value={r}>
          {ROLE_LABELS[r]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export default function Team() {
  const { people, tokens, me } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const shown = fetcher.data ?? result;
  const secret = shown && 'secret' in shown ? shown.secret : null;
  const error = shown && 'error' in shown ? shown.error : null;
  const busy = fetcher.state !== 'idle';
  if (me.kind === 'open') return <FirstOperator error={error} />;
  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Who can sign in, what each role may do, and the tokens other systems use."
        actions={
          <Link to="/audit" className="text-link text-sm hover:underline">
            Audit log
          </Link>
        }
      />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <div className="max-w-[1000px] space-y-6">
          <p className="text-muted-foreground text-sm">
            <b className="font-medium text-foreground">Viewers</b> see everything and use the ops
            chat. <b className="font-medium text-foreground">Approvers</b> also decide approvals.{' '}
            <b className="font-medium text-foreground">Operators</b> also start, cancel and restart
            orders, deliver events, edit and publish flows, and manage this page.
          </p>

          {secret ? (
            <div role="status" className="rounded-md border border-wait/40 bg-wait/10 p-4 text-sm">
              <p className="font-medium">{secret.label}</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                Copy it now. It is shown once and stored only as a hash.
              </p>
              <code className="mt-2 block select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-sm">
                {secret.value}
              </code>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <Section title="People" flush>
            {people.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left">
                    <tr>
                      <th scope="col" className="caption px-4 py-2 font-medium">
                        Person
                      </th>
                      <th scope="col" className="caption px-2 py-2 font-medium">
                        Role
                      </th>
                      <th scope="col" className="caption px-2 py-2 font-medium">
                        Last sign-in
                      </th>
                      <th scope="col" className="caption px-4 py-2 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {people.map((p) => (
                      <tr key={p.id} className={p.disabledAt ? 'text-muted-foreground' : undefined}>
                        <td className="px-4 py-2">
                          {p.name}
                          {p.id === me.id ? (
                            <span className="ml-1.5 text-muted-foreground text-xs">you</span>
                          ) : null}
                          <div className="text-muted-foreground text-xs">
                            {p.email}
                            {p.disabledAt ? ' · disabled' : ''}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <fetcher.Form method="post" className="flex items-center gap-1.5">
                            <input type="hidden" name="intent" value="role" />
                            <input type="hidden" name="id" value={p.id} />
                            <RoleSelect value={p.role as Role} />
                            <Button size="sm" variant="outline" type="submit" disabled={busy}>
                              Save
                            </Button>
                          </fetcher.Form>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground text-xs">
                          {p.lastLoginAt ? <Ago ms={p.lastLoginAt} /> : 'Never'}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex justify-end gap-1.5">
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="reset" />
                              <input type="hidden" name="id" value={p.id} />
                              <Button size="sm" variant="ghost" type="submit" disabled={busy}>
                                Reset password
                              </Button>
                            </fetcher.Form>
                            {p.id !== me.id ? (
                              <fetcher.Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value={p.disabledAt ? 'enable' : 'disable'}
                                />
                                <input type="hidden" name="id" value={p.id} />
                                <Button size="sm" variant="ghost" type="submit" disabled={busy}>
                                  {p.disabledAt ? 'Enable' : 'Disable'}
                                </Button>
                              </fetcher.Form>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                Nobody has their own sign-in yet. Add the first person below; until then the
                workspace password is the only way in.
              </Empty>
            )}
            <fetcher.Form
              method="post"
              className="grid gap-2 border-t p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
            >
              <input type="hidden" name="intent" value="add-user" />
              <Input name="email" type="email" required placeholder="Email" aria-label="Email" />
              <Input name="name" placeholder="Name (optional)" aria-label="Name" />
              <RoleSelect />
              <Button type="submit" disabled={busy}>
                Add person
              </Button>
            </fetcher.Form>
          </Section>

          <Section title="API tokens" flush>
            {tokens.length ? (
              <ul className="divide-y text-sm">
                {tokens.map((t) => (
                  <li
                    key={t.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 ${t.revokedAt ? 'text-muted-foreground' : ''}`}
                  >
                    <span className="font-medium">{t.name}</span>
                    <code className="font-mono text-muted-foreground text-xs">{t.prefix}…</code>
                    <span className="text-xs">{ROLE_LABELS[t.role as Role]}</span>
                    <span className="text-muted-foreground text-xs">
                      by {t.createdBy} ·{' '}
                      {t.lastUsedAt ? (
                        <>
                          used <Ago ms={t.lastUsedAt} />
                        </>
                      ) : (
                        'never used'
                      )}
                      {t.revokedAt ? ' · revoked' : ''}
                    </span>
                    {t.revokedAt ? null : (
                      <fetcher.Form method="post" className="ml-auto">
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="id" value={t.id} />
                        <Button size="sm" variant="ghost" type="submit" disabled={busy}>
                          Revoke
                        </Button>
                      </fetcher.Form>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No API tokens. Systems that call the REST API need one.</Empty>
            )}
            <fetcher.Form
              method="post"
              className="grid gap-2 border-t p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
            >
              <input type="hidden" name="intent" value="add-token" />
              <Input
                name="name"
                required
                placeholder="What will use it, e.g. ERP sync"
                aria-label="Token name"
              />
              <RoleSelect value="operator" />
              <Button type="submit" disabled={busy}>
                Create token
              </Button>
            </fetcher.Form>
          </Section>
        </div>
      </div>
    </>
  );
}

/** An open deployment: whoever sets it up creates the first operator account, which turns sign-in on. */
function FirstOperator({ error }: { error: string | null }) {
  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Anyone can use this workspace until it has a first operator."
      />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <div className="max-w-[560px]">
          <Section title="Create your operator account">
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="first-operator" />
              <p className="text-muted-foreground text-sm">
                From then on everyone signs in, and you add people and API tokens here. Choose a
                password of at least 10 characters.
              </p>
              <Input name="email" type="email" required placeholder="Email" aria-label="Email" />
              <Input name="name" placeholder="Name (optional)" aria-label="Name" />
              <Input
                name="password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                placeholder="Password"
                aria-label="Password"
              />
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}
              <Button type="submit">Create account and sign in</Button>
            </Form>
          </Section>
        </div>
      </div>
    </>
  );
}
