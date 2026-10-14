import { ROLE_LABELS, ROLES, type Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { useEffect, useRef, useState } from 'react';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from 'react-router';
import { Ago } from '~/components/ago';
import { CopyButton } from '~/components/copy-button';
import { Field } from '~/components/inspector';
import { Empty, PageHeader, Section } from '~/components/page';
import { requireUser, startSession } from '~/lib/auth.server';
import { setTwoFactorRequirement, twoFactorRequirement } from '~/lib/settings.server';
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
import { DEFAULT_LIFETIME, TOKEN_LIFETIMES, type TokenState, tokenState } from '~/lib/tokens';
import {
  isTwoFactorRequirement,
  mustUseTwoFactor,
  TWO_FACTOR_REQUIREMENTS,
  type TwoFactorRequirement,
} from '~/lib/two-factor';
import { resetTwoFactor } from '~/lib/two-factor.server';
import { useDateTime } from '~/lib/use-date-time';
import type { Route } from './+types/team';

export const meta = () => [{ title: 'Team · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'operator');
  // One clock for the page, so the server and the hydrating browser agree on each token's state.
  const [team, twoFactorRequired] = await Promise.all([listTeam(), twoFactorRequirement()]);
  return { ...team, twoFactorRequired, me, now: Date.now() };
}

/** One-time secrets come back from the action and are shown once, never stored in the clear. */
type Secret = { kind: 'password' | 'token'; label: string; value: string };

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
      return redirect('/team', { headers: { 'set-cookie': await startSession(request, id) } });
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
        return {
          secret: {
            kind: 'password',
            label: `Password for ${r.email}`,
            value: r.password,
          } as Secret,
        };
      }
      case 'role':
        await setRole(request, me, str('id'), str('role'));
        return { ok: true };
      case 'reset': {
        const r = await resetPassword(request, me, str('id'));
        return {
          secret: {
            kind: 'password',
            label: `New password for ${r.email}`,
            value: r.password,
          } as Secret,
        };
      }
      case 'two-factor-requirement': {
        const next = str('required');
        if (!isTwoFactorRequirement(next))
          throw new TeamError('Pick who must use two-factor sign-in.');
        await setTwoFactorRequirement(request, me, next);
        return { ok: true };
      }
      case 'reset-two-factor':
        await resetTwoFactor(request, me, str('id'));
        return { ok: true };
      case 'disable':
      case 'enable':
        await setDisabled(request, me, str('id'), str('intent') === 'disable');
        return { ok: true };
      case 'add-token': {
        const r = await createToken(request, me, {
          name: str('name'),
          role: str('role'),
          lifetime: str('lifetime'),
        });
        return {
          secret: { kind: 'token', label: `API token “${r.name}”`, value: r.token } as Secret,
        };
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

/** What each role may do, in the product's words. The role is the boundary for people and tokens. */
const ROLE_GUIDE: Record<Role, string> = {
  viewer: 'Sees every order and flow, and asks the assistant. Changes nothing.',
  approver: 'Also decides approvals. Can’t cancel orders, deliver events or publish flows.',
  operator:
    'Also starts, cancels and restarts orders, delivers events, edits and publishes flows, and manages this page.',
};

function RoleGuide() {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      {ROLES.map((r) => (
        <div key={r}>
          <dt className="font-medium">{ROLE_LABELS[r]}</dt>
          <dd className="mt-0.5 text-muted-foreground">{ROLE_GUIDE[r]}</dd>
        </div>
      ))}
    </dl>
  );
}

function RoleSelect({
  name = 'role',
  value,
  onChange,
  label,
}: {
  name?: string;
  value?: string;
  onChange?: (role: Role) => void;
  /** For a select with no visible label of its own, such as one per table row. */
  label?: string;
}) {
  return (
    <NativeSelect
      aria-label={label}
      name={name}
      defaultValue={value ?? 'viewer'}
      className="h-8 w-full"
      onChange={(e) => onChange?.(e.target.value as Role)}
    >
      {ROLES.map((r) => (
        <NativeSelectOption key={r} value={r}>
          {ROLE_LABELS[r]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export default function Team() {
  const { people, tokens, me, now, twoFactorRequired } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const shown = fetcher.data ?? result;
  const secret = shown && 'secret' in shown ? shown.secret : null;
  const error = shown && 'error' in shown ? shown.error : null;
  const busy = fetcher.state !== 'idle';
  const [tokenRole, setTokenRole] = useState<Role>('operator');
  const secretRef = useRef<HTMLDivElement>(null);
  const addPerson = useRef<HTMLFormElement>(null);
  const addToken = useRef<HTMLFormElement>(null);
  // A new secret takes focus (it's what to act on next) and the form that made it starts fresh.
  useEffect(() => {
    if (!secret) return;
    secretRef.current?.focus();
    (secret.kind === 'token' ? addToken : addPerson).current?.reset();
  }, [secret]);
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
          <Section title="Roles">
            <RoleGuide />
          </Section>

          {secret ? (
            <div
              ref={secretRef}
              tabIndex={-1}
              className="rounded-md border border-wait/40 bg-wait/10 p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <p className="font-medium">{secret.label}</p>
              <p className="mt-0.5 max-w-[75ch] text-muted-foreground text-xs">
                {secret.kind === 'password'
                  ? 'Send it to them privately. It is temporary: they choose their own when they first sign in. It is shown once.'
                  : 'Copy it now. It is shown once and stored only as a hash.'}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-sm">
                  {secret.value}
                </code>
                <CopyButton text={secret.value} />
              </div>
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
                            {p.twoFactorAt ? ' · two-factor' : ''}
                            {p.passwordChangeDue ? ' · temporary password' : ''}
                            {p.disabledAt ? ' · disabled' : ''}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <fetcher.Form method="post" className="flex items-center gap-1.5">
                            <input type="hidden" name="intent" value="role" />
                            <input type="hidden" name="id" value={p.id} />
                            <RoleSelect value={p.role as Role} label={`Role for ${p.name}`} />
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
                            <Confirmed
                              fetcher={fetcher}
                              intent="reset"
                              id={p.id}
                              busy={busy}
                              label="Reset password"
                              question={`Give ${p.name} a temporary password and sign them out everywhere?`}
                            />
                            {p.twoFactorAt && p.id !== me.id ? (
                              <Confirmed
                                fetcher={fetcher}
                                intent="reset-two-factor"
                                id={p.id}
                                busy={busy}
                                label="Reset two-factor"
                                question={`Turn off ${p.name}’s two-factor sign-in so they can set it up again?`}
                              />
                            ) : null}
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
              ref={addPerson}
              method="post"
              className="grid items-end gap-3 border-t p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto]"
            >
              <input type="hidden" name="intent" value="add-user" />
              <Field label="Email">
                <Input name="email" type="email" required placeholder="name@company.com" />
              </Field>
              <Field label="Name" hint="Optional">
                <Input name="name" />
              </Field>
              <Field label="Role">
                <RoleSelect />
              </Field>
              <Button type="submit" disabled={busy}>
                Add person
              </Button>
            </fetcher.Form>
          </Section>

          <TwoFactorRequirementForm
            required={twoFactorRequired}
            missing={
              people.filter(
                (p) =>
                  !p.disabledAt &&
                  !p.twoFactorAt &&
                  mustUseTwoFactor(p.role as Role, twoFactorRequired),
              ).length
            }
          />

          <Section title="API tokens" flush>
            {tokens.length ? (
              <ul className="divide-y text-sm">
                {tokens.map((t) => (
                  <li
                    key={t.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 ${tokenState(t, now) === 'revoked' || tokenState(t, now) === 'expired' ? 'text-muted-foreground' : ''}`}
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
                    <TokenExpiry state={tokenState(t, now)} expiresAt={t.expiresAt} />
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
              ref={addToken}
              method="post"
              className="grid items-end gap-3 border-t p-4 sm:grid-cols-[minmax(0,1fr)_10rem_9rem_auto]"
            >
              <input type="hidden" name="intent" value="add-token" />
              <Field label="Used by">
                <Input name="name" required placeholder="e.g. ERP sync" />
              </Field>
              <Field label="Role">
                <RoleSelect value="operator" onChange={setTokenRole} />
              </Field>
              <Field label="Expires after">
                <NativeSelect
                  name="lifetime"
                  defaultValue={DEFAULT_LIFETIME}
                  className="h-8 w-full"
                >
                  {Object.entries(TOKEN_LIFETIMES).map(([k, label]) => (
                    <NativeSelectOption key={k} value={k}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Button type="submit" disabled={busy}>
                Create token
              </Button>
              {/* The role is the boundary: say what this token will be able to do before it exists. */}
              <p
                className="max-w-[75ch] text-muted-foreground text-xs sm:col-span-4"
                aria-live="polite"
              >
                A token with the {ROLE_LABELS[tokenRole].toLowerCase()} role:{' '}
                {ROLE_GUIDE[tokenRole].charAt(0).toLowerCase() + ROLE_GUIDE[tokenRole].slice(1)}
              </p>
            </fetcher.Form>
          </Section>
        </div>
      </div>
    </>
  );
}

/** An action that can't be taken back, confirmed in place before it runs. */
function Confirmed({
  fetcher,
  intent,
  id,
  busy,
  label,
  question,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  intent: string;
  id: string;
  busy: boolean;
  label: string;
  question: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button size="sm" variant="ghost" type="button" onClick={() => setAsking(true)}>
        {label}…
      </Button>
    );
  return (
    <fetcher.Form
      method="post"
      className="flex flex-wrap items-center justify-end gap-1.5"
      onSubmit={() => setAsking(false)}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <span className="max-w-64 text-right text-xs">{question}</span>
      <Button size="sm" variant="destructive" type="submit" disabled={busy} autoFocus>
        {label}
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </fetcher.Form>
  );
}

/** An open deployment: whoever sets it up creates the first operator account, which turns sign-in on. */
function FirstOperator({ error }: { error: string | null }) {
  const creating = useNavigation().state === 'submitting';
  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Anyone can use this workspace until it has a first operator."
      />
      <div className="mx-auto max-w-[1400px] px-4 pb-10 sm:px-6">
        <div className="grid max-w-[1000px] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Section title="Create your operator account">
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="first-operator" />
              <p className="text-muted-foreground text-sm">
                From then on everyone signs in, and you add people and API tokens here.
              </p>
              <Field label="Email">
                <Input
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  placeholder="name@company.com"
                />
              </Field>
              <Field label="Name" hint="Optional">
                <Input name="name" />
              </Field>
              <Field label="Password" hint="At least 10 characters">
                <Input
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                />
              </Field>
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create account and sign in'}
              </Button>
            </Form>
          </Section>
          <Section title="Roles you can give people and tokens">
            <div className="[&_dl]:sm:grid-cols-1">
              <RoleGuide />
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

/** When a token stops working, flagged once it is close. */
function TokenExpiry({ state, expiresAt }: { state: TokenState; expiresAt: number | null }) {
  const formatTime = useDateTime();
  if (state === 'revoked') return null;
  if (expiresAt === null)
    return <span className="text-muted-foreground text-xs">never expires</span>;
  if (state === 'expired')
    return <span className="font-medium text-bad text-xs">expired {formatTime(expiresAt)}</span>;
  return (
    <span
      className={`text-xs ${state === 'expiring' ? 'font-medium text-wait' : 'text-muted-foreground'}`}
    >
      expires {formatTime(expiresAt)}
    </span>
  );
}

/** Which roles must use two-factor sign-in; people without it are sent to set it up. */
function TwoFactorRequirementForm({
  required,
  missing,
}: {
  required: TwoFactorRequirement;
  missing: number;
}) {
  const fetcher = useFetcher();
  return (
    <Section title="Two-factor sign-in">
      <fetcher.Form method="post" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="intent" value="two-factor-requirement" />
        <label htmlFor="tf-required" className="text-sm">
          Required for
        </label>
        <NativeSelect id="tf-required" name="required" defaultValue={required} className="h-8">
          {Object.entries(TWO_FACTOR_REQUIREMENTS).map(([k, label]) => (
            <NativeSelectOption key={k} value={k}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button size="sm" variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
          Save
        </Button>
      </fetcher.Form>
      <p className="mt-2 max-w-[75ch] text-muted-foreground text-xs">
        People in these roles without two-factor sign-in can only use their Account page until they
        set it up, and can’t turn it off. The workspace password and API tokens aren’t affected.
        {required !== 'off' && missing
          ? ` ${missing} ${missing === 1 ? 'person hasn’t' : 'people haven’t'} set it up yet.`
          : ''}
      </p>
    </Section>
  );
}
