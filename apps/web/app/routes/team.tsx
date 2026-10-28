import { isRole, ROLE_LABELS, ROLES, type Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@orderloop/ui/dropdown-menu';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Ellipsis } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
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
import { Confirm } from '~/components/confirm';
import { CopyButton } from '~/components/copy-button';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Field } from '~/components/inspector';
import { Empty, PageHeader, Section } from '~/components/page';
import { StepUpField } from '~/components/step-up-field';
import { audit } from '~/lib/audit.server';
import {
  requireUser,
  type StepUpMethod,
  startSession,
  stepUp,
  stepUpMethod,
} from '~/lib/auth.server';
import { SCIM_PATH, SCIM_TOKEN_MS } from '~/lib/scim';
import {
  createScimToken,
  revokeScimToken,
  scimGroupsWithRoles,
  scimTokenSet,
  setScimRoles,
} from '~/lib/scim.server';
import {
  approvalSeparation,
  setApprovalSeparation,
  setSsoSettings,
  setTwoFactorRequirement,
  ssoSettings,
  twoFactorRequirement,
} from '~/lib/settings.server';
import { parseDomains, type SsoSettings } from '~/lib/sso';
import { linkedToSso, ssoConfig } from '~/lib/sso.server';
import {
  addUser,
  createFirstAdmin,
  createToken,
  listTeam,
  needsStepUp,
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
  const me = await requireUser(request, 'admin');
  const stepUp = await stepUpMethod(me);
  // One clock for the page, so the server and the hydrating browser agree on each token's state.
  const [team, twoFactorRequired, separated, sso, scimToken, scimGroups] = await Promise.all([
    listTeam(),
    twoFactorRequirement(),
    approvalSeparation(),
    ssoSettings(),
    scimTokenSet(),
    scimGroupsWithRoles(),
  ]);
  const provider = ssoConfig();
  // The address a new person signs in at, to send along with their temporary password.
  const signInUrl = new URL('/login', request.url).href;
  return {
    ...team,
    twoFactorRequired,
    separated,
    sso: provider
      ? { issuer: provider.issuer, settings: sso, linked: await linkedToSso(me.id) }
      : null,
    scim: {
      endpoint: new URL(SCIM_PATH, request.url).href,
      token: scimToken,
      groups: scimGroups,
    },
    me,
    now: Date.now(),
    signInUrl,
    stepUp,
  };
}

/** One-time secrets come back from the action and are shown once, never stored in the clear. */
type Secret = { kind: 'password' | 'token'; label: string; value: string };

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  const f = await request.formData();
  const str = (k: string) => String(f.get(k) ?? '');
  try {
    if (str('intent') === 'first-admin') {
      if (me.kind !== 'open') throw new TeamError('The team already has people.');
      const id = await createFirstAdmin(request, {
        email: str('email'),
        name: str('name'),
        password: str('password'),
      });
      return redirect('/team', { headers: { 'set-cookie': await startSession(request, id) } });
    }
    if (me.kind === 'user' && (await needsStepUp(str('intent'), f))) {
      const failed = await stepUp(request, me, { code: str('code'), password: str('password') });
      if (failed) {
        await audit(request, 'auth.step_up_failed', {
          actor: me,
          target: str('who') || null,
          detail: { intent: str('intent'), error: failed, ...(str('id') ? { id: str('id') } : {}) },
        });
        return data({ error: failed }, { status: 403 });
      }
    }
    switch (str('intent')) {
      case 'add-user': {
        if (me.kind === 'open')
          throw new TeamError(
            'Create your own admin account first; adding people turns on sign-in.',
          );
        const r = await addUser(request, me, {
          email: str('email'),
          name: str('name'),
          role: str('role'),
        });
        return {
          secret: {
            kind: 'password',
            label: `Temporary password for ${r.email}`,
            value: r.password,
          } as Secret,
        };
      }
      case 'role':
        await setRole(request, me, str('id'), str('role'));
        return {
          ok: true,
          done: `${str('who')}’s role is now ${isRole(str('role')) ? ROLE_LABELS[str('role') as Role] : str('role')}.`,
        };
      case 'reset': {
        const r = await resetPassword(request, me, str('id'));
        return {
          secret: {
            kind: 'password',
            label: `New temporary password for ${r.email}`,
            value: r.password,
          } as Secret,
        };
      }
      case 'two-factor-requirement': {
        const next = str('required');
        if (!isTwoFactorRequirement(next))
          throw new TeamError('Pick who must use two-factor sign-in.');
        await setTwoFactorRequirement(request, me, next);
        return { ok: true, done: 'Two-factor requirement saved.' };
      }
      case 'sso-settings': {
        if (!ssoConfig()) throw new TeamError('Single sign-on isn’t set up for this workspace.');
        const jit = str('jit');
        const next: SsoSettings = {
          jitRole: isRole(jit) && jit !== 'admin' ? jit : null,
          domains: parseDomains(str('domains')),
          ssoOnly: str('only') === 'on',
        };
        if (next.jitRole && !next.domains.length)
          throw new TeamError('List the email domains new people may join from.');
        // Proof it works before it is the only way in: whoever turns passwords off has used it.
        if (next.ssoOnly && !(await linkedToSso(me.id)))
          throw new TeamError(
            'Sign in with single sign-on yourself once before turning passwords off.',
          );
        await setSsoSettings(request, me, next);
        return { ok: true, done: 'Single sign-on settings saved.' };
      }
      case 'approval-separation': {
        const on = str('separated') === 'on';
        await setApprovalSeparation(request, me, on);
        return {
          ok: true,
          done: on
            ? 'Saved: no one may approve an order they started.'
            : 'Saved: anyone with the Approver role may approve any order.',
        };
      }
      case 'reset-two-factor':
        await resetTwoFactor(request, me, str('id'));
        return {
          ok: true,
          done: `${str('who')}’s two-factor sign-in is off; they can set it up again.`,
        };
      case 'disable':
      case 'enable':
        await setDisabled(request, me, str('id'), str('intent') === 'disable');
        return {
          ok: true,
          done:
            str('intent') === 'disable'
              ? `${str('who')} is disabled and signed out everywhere.`
              : `${str('who')} can sign in again.`,
        };
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
      case 'scim-token':
        return {
          secret: {
            kind: 'token',
            label: 'SCIM token',
            value: await createScimToken(request, me),
          } as Secret,
        };
      case 'scim-revoke':
        await revokeScimToken(request, me);
        return {
          ok: true,
          done: 'SCIM token revoked. Provisioning stops until you make a new one.',
        };
      case 'scim-roles': {
        const map: Record<string, Role> = {};
        for (const [k, v] of f.entries())
          if (k.startsWith('role:') && isRole(v)) map[k.slice('role:'.length)] = v;
        await setScimRoles(request, me, map);
        return { ok: true, done: 'Group roles saved; members’ roles follow them now.' };
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
    'Also starts, cancels and restarts orders, delivers events, and edits and publishes flows.',
  admin:
    'Also manages this page (people, API tokens, sign-in rules), webhooks and integrations, and reads the audit log.',
};

function RoleGuide() {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {ROLES.map((r) => (
        <div key={r}>
          <dt className="font-medium">{ROLE_LABELS[r]}</dt>
          <dd className="mt-0.5 text-muted-foreground">{ROLE_GUIDE[r]}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A person's role, saved from their row; making them an admin asks who you are first. Save shows
 * only once the role is changed, so a row at rest is just its role.
 */
export function RoleForm({
  id,
  name,
  role,
  stepUp,
  fetcher,
}: {
  id: string;
  name: string;
  role: Role;
  stepUp: StepUpMethod | null;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [chosen, setChosen] = useState<Role>(role);
  return (
    <fetcher.Form method="post" className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="intent" value="role" />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="who" value={name} />
      <RoleSelect value={role} label={`Role for ${name}`} compact onChange={setChosen} />
      {chosen !== role ? (
        <Button
          size="sm"
          variant="outline"
          type="submit"
          aria-label={`Save role for ${name}`}
          disabled={fetcher.state !== 'idle'}
        >
          Save
        </Button>
      ) : null}
      {chosen === 'admin' && role !== 'admin' ? <StepUpField method={stepUp} next="/team" /> : null}
    </fetcher.Form>
  );
}

function RoleSelect({
  name = 'role',
  value,
  onChange,
  label,
  compact,
}: {
  name?: string;
  value?: string;
  onChange?: (role: Role) => void;
  /** For a select with no visible label of its own, such as one per table row. */
  label?: string;
  /** Beside a small button (a table row); in a form it matches the text fields' height. */
  compact?: boolean;
}) {
  return (
    <NativeSelect
      aria-label={label}
      name={name}
      defaultValue={value ?? 'viewer'}
      className={cn('w-full min-w-28', compact ? 'h-8' : 'h-9')}
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
  const { people, tokens, me, now, twoFactorRequired, separated, sso, scim, signInUrl, stepUp } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const shown = fetcher.data ?? result;
  const secret = shown && 'secret' in shown ? shown.secret : null;
  const error = shown && 'error' in shown ? shown.error : null;
  const busy = fetcher.state !== 'idle';
  // Each create form closes once its secret comes back, and the page shows the secret once. A
  // refusal (a failed step-up, an address already on the team) keeps the sheet open with what
  // was typed. Nothing else on the page can be submitted while a sheet is open.
  const addPerson = useFormSheet(
    shown,
    (r) => 'secret' in r && (r.secret as Secret).kind === 'password',
  );
  const addToken = useFormSheet(
    shown,
    (r) => 'secret' in r && (r.secret as Secret).kind === 'token',
  );
  const secretRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const done = shown && 'done' in shown ? shown.done : null;
  const [asking, setAsking] = useState<{ id: string; intent: Asked } | null>(null);
  const ask = (id: string, intent: Asked) => setAsking({ id, intent });
  // Keep returns to the row's actions menu; nothing is lost if the person changes their mind.
  const keep = () => {
    const was = asking;
    setAsking(null);
    if (was)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-ask="${was.id}"]`)?.focus(),
      );
  };
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);
  // A new secret takes focus: it's what to act on next. Made in a sheet, it takes it as the sheet
  // closes, instead of the button that opened it (`toSecret`).
  useEffect(() => {
    if (secret) secretRef.current?.focus();
  }, [secret]);
  const toSecret = (e: Event) => {
    if (!secret) return;
    e.preventDefault();
    secretRef.current?.focus();
  };
  if (me.kind === 'open') return <FirstAdmin error={error} />;
  return (
    <>
      <PageHeader
        title="Team"
        subtitle={
          <>
            Who can sign in, what each role may do, and the tokens other systems use. Every change
            here is recorded in the{' '}
            <Link to="/audit" className="text-link hover:underline">
              audit log
            </Link>
            .
          </>
        }
      />
      <div className="mx-auto max-w-page px-4 pb-10 sm:px-6">
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
              <p className="mt-0.5 max-w-[65ch] text-muted-foreground text-xs">
                {secret.kind === 'password' ? (
                  <>
                    Send it to them privately, with the sign-in page{' '}
                    <span className="font-mono">{signInUrl}</span>. It is temporary: they choose
                    their own when they first sign in. It is shown once.
                  </>
                ) : (
                  'Copy it now. It is shown once and stored only as a hash.'
                )}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-sm">
                  {secret.value}
                </code>
                <CopyButton text={secret.value} />
              </div>
            </div>
          ) : null}
          {/* A sheet's refusal shows in the sheet, under its fields. */}
          {error && !addPerson.open && !addToken.open ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          {done ? (
            <p ref={doneRef} tabIndex={-1} role="status" className="text-sm outline-none">
              {done}
            </p>
          ) : null}

          <Section
            title="People"
            flush
            actions={
              <FormSheet
                open={addPerson.open}
                onOpenChange={addPerson.onOpenChange}
                onCloseAutoFocus={toSecret}
                label="Add person"
                description="They get a temporary password, shown once, to send them with the sign-in page."
              >
                <AddPersonForm
                  fetcher={fetcher}
                  stepUp={stepUp}
                  busy={busy}
                  error={sheetError(addPerson.result)}
                />
              </FormSheet>
            }
          >
            {people.length ? (
              <div>
                {/* A table on wide screens; on a phone each person stacks into a block, so the
                    role select keeps its width and nothing pushes the page sideways. */}
                <Table stack="rows" caption="People">
                  <TableHead>
                    <Tr>
                      <Th>Person</Th>
                      <Th>Role</Th>
                      <Th>Last sign-in</Th>
                      <Th className="w-0 text-right">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {people.map((p) => (
                      <Fragment key={p.id}>
                        <Tr
                          className={cn(
                            'relative block space-y-2 px-4 py-3 md:table-row md:space-y-0 md:p-0',
                            p.disabledAt && 'text-muted-foreground',
                          )}
                        >
                          <Td className="block max-md:pr-10 md:table-cell">
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
                          </Td>
                          <Td className="block md:table-cell">
                            <RoleForm
                              // Saved (here or elsewhere), the row starts again from the new role.
                              key={p.role}
                              id={p.id}
                              name={p.name}
                              role={p.role as Role}
                              stepUp={stepUp}
                              fetcher={fetcher}
                            />
                          </Td>
                          <Td className="block text-muted-foreground text-xs md:table-cell">
                            <span aria-hidden="true" className="md:hidden">
                              Last sign-in:{' '}
                            </span>
                            {p.lastLoginAt ? <Ago ms={p.lastLoginAt} /> : 'Never'}
                          </Td>
                          {/* On a phone the menu sits in the person's top corner, beside their name. */}
                          <Td className="absolute top-2 right-2 block md:static md:table-cell md:text-right">
                            <RowActions
                              id={p.id}
                              name={p.name}
                              self={p.id === me.id}
                              twoFactor={!!p.twoFactorAt}
                              disabled={!!p.disabledAt}
                              ask={ask}
                            />
                          </Td>
                        </Tr>
                        {/* The question gets its own line under the person, so their row keeps its
                          shape and the name stays beside what's being asked. */}
                        {asking?.id === p.id ? (
                          <Tr className="block md:table-row">
                            <Td colSpan={4} className="block px-4 pt-0 pb-3 md:table-cell">
                              <fetcher.Form
                                method="post"
                                className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
                                onSubmit={() => setAsking(null)}
                              >
                                <input type="hidden" name="intent" value={asking.intent} />
                                <input type="hidden" name="id" value={p.id} />
                                <input type="hidden" name="who" value={p.name} />
                                <Confirm
                                  message={QUESTIONS[asking.intent](p.name)}
                                  cancelLabel="Keep"
                                  onCancel={keep}
                                  className="flex-1"
                                >
                                  {asking.intent === 'disable' ||
                                  (asking.intent === 'enable' && p.role === 'viewer') ? null : (
                                    <StepUpField method={stepUp} next="/team" />
                                  )}
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    type="submit"
                                    disabled={busy}
                                  >
                                    {ACTIONS[asking.intent]}
                                  </Button>
                                </Confirm>
                              </fetcher.Form>
                            </Td>
                          </Tr>
                        ) : null}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Empty>Nobody is on the team yet.</Empty>
            )}
          </Section>

          <TwoFactorRequirementForm
            stepUp={stepUp}
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

          {sso ? <SsoForm {...sso} stepUp={stepUp} /> : null}

          <ScimSection {...scim} stepUp={stepUp} fetcher={fetcher} now={now} />

          <ApprovalSeparationForm separated={separated} />

          <Section
            title="API tokens"
            flush
            actions={
              <FormSheet
                open={addToken.open}
                onOpenChange={addToken.onOpenChange}
                onCloseAutoFocus={toSecret}
                label="Create token"
                title="Create an API token"
                description="For a system that calls the REST API. The token is shown once."
              >
                <AddTokenForm
                  fetcher={fetcher}
                  stepUp={stepUp}
                  busy={busy}
                  error={sheetError(addToken.result)}
                />
              </FormSheet>
            }
          >
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
          </Section>
        </div>
      </div>
    </>
  );
}

type Asked = 'reset' | 'reset-two-factor' | 'disable' | 'enable';

/** A refusal that came back while a create sheet was open, to show under its fields. */
const sheetError = (r: unknown) =>
  r && typeof r === 'object' && 'error' in r ? String(r.error) : null;

/** The fields of a new person; the action checks them (`addUser`). */
function AddPersonForm({
  fetcher,
  stepUp,
  busy,
  error,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  stepUp: StepUpMethod | null;
  busy: boolean;
  error: string | null;
}) {
  const [role, setRole] = useState<Role>('viewer');
  return (
    <fetcher.Form method="post" className="grid gap-3">
      <input type="hidden" name="intent" value="add-user" />
      <Field label="Email">
        {/* Someone else's address: keep a password manager from offering yours. */}
        <Input
          name="email"
          type="email"
          required
          autoComplete="off"
          placeholder="name@company.com"
        />
      </Field>
      <Field label="Name (optional)">
        <Input name="name" autoComplete="off" />
      </Field>
      <Field label="Role">
        <RoleSelect onChange={setRole} />
      </Field>
      {/* Making an admin is what needs proof it's you. */}
      {role === 'admin' ? <StepUpField method={stepUp} next="/team" /> : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          Add person
        </Button>
      </div>
    </fetcher.Form>
  );
}

/** The fields of a new API token; the action checks them (`createToken`). */
function AddTokenForm({
  fetcher,
  stepUp,
  busy,
  error,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  stepUp: StepUpMethod | null;
  busy: boolean;
  error: string | null;
}) {
  const [role, setRole] = useState<Role>('viewer');
  return (
    <fetcher.Form method="post" className="grid gap-3">
      <input type="hidden" name="intent" value="add-token" />
      <Field label="Used by">
        <Input name="name" required placeholder="e.g. ERP sync" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Role">
          <RoleSelect value="viewer" onChange={setRole} />
        </Field>
        <Field label="Expires after">
          <NativeSelect name="lifetime" defaultValue={DEFAULT_LIFETIME} className="h-9 w-full">
            {Object.entries(TOKEN_LIFETIMES).map(([k, label]) => (
              <NativeSelectOption key={k} value={k}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {/* The role is the boundary: say what this token will be able to do before it exists. */}
      <p className="max-w-[65ch] text-muted-foreground text-xs" aria-live="polite">
        A token with the {ROLE_LABELS[role].toLowerCase()} role:{' '}
        {ROLE_GUIDE[role].charAt(0).toLowerCase() + ROLE_GUIDE[role].slice(1)}
      </p>
      <StepUpField method={stepUp} next="/team" />
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          Create token
        </Button>
      </div>
    </fetcher.Form>
  );
}

const QUESTIONS: Record<Asked, (name: string) => string> = {
  reset: (n) => `Give ${n} a temporary password and sign them out everywhere?`,
  'reset-two-factor': (n) => `Turn off ${n}’s two-factor sign-in so they can set it up again?`,
  disable: (n) => `Disable ${n}? They can’t sign in, and they’re signed out everywhere.`,
  enable: (n) => `Enable ${n}? They can sign in again with their password or single sign-on.`,
};

const ACTIONS: Record<Asked, string> = {
  reset: 'Reset password',
  'reset-two-factor': 'Reset two-factor',
  disable: 'Disable',
  enable: 'Enable',
};

/**
 * A person's other actions, in one menu so each row has the same shape. Each opens its
 * confirmation under the row, which takes focus; keeping returns it to this menu's button.
 */
export function RowActions({
  id,
  name,
  self,
  twoFactor,
  disabled,
  ask,
}: {
  id: string;
  name: string;
  self: boolean;
  twoFactor: boolean;
  disabled: boolean;
  ask: (id: string, intent: Asked) => void;
}) {
  // Picking an item hands focus to the confirmation, so the menu mustn't take it back on close.
  const picked = useRef(false);
  const pick = (intent: Asked) => () => {
    picked.current = true;
    ask(id, intent);
  };
  // A finger gets a 44px row; a pointer keeps the menu's drawn size.
  const item = 'touch:min-h-11';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" data-ask={id} aria-label={`Actions for ${name}`}>
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (!picked.current) return;
          picked.current = false;
          e.preventDefault();
        }}
      >
        <DropdownMenuItem className={item} onSelect={pick('reset')}>
          Reset password…
        </DropdownMenuItem>
        {twoFactor && !self ? (
          <DropdownMenuItem className={item} onSelect={pick('reset-two-factor')}>
            Reset two-factor…
          </DropdownMenuItem>
        ) : null}
        {/* Disabling sits apart from the resets, so a thumb aimed at one doesn't land on the other. */}
        {self ? null : (
          <>
            <DropdownMenuSeparator />
            {disabled ? (
              <DropdownMenuItem className={item} onSelect={pick('enable')}>
                Enable…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className={item} variant="destructive" onSelect={pick('disable')}>
                Disable…
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An open deployment: whoever sets it up creates the first admin account, which turns sign-in on. */
function FirstAdmin({ error }: { error: string | null }) {
  const creating = useNavigation().state === 'submitting';
  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Anyone can use this workspace until it has a first admin."
      />
      <div className="mx-auto max-w-page px-4 pb-10 sm:px-6">
        <div className="grid max-w-[1000px] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Section title="Create your admin account">
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="first-admin" />
              <p className="text-muted-foreground text-sm">
                Once it exists, everyone signs in, and you add people and API tokens here.
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
              <Field label="Name (optional)">
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

/** SCIM provisioning: the endpoint, its token, and which pushed groups give which role. */
function ScimSection({
  endpoint,
  token,
  groups,
  stepUp,
  fetcher,
  now,
}: {
  /** The loader's clock, so the server and the browser agree on whether the token expired. */
  now: number;
  stepUp: StepUpMethod | null;
  endpoint: string;
  token: { updatedAt: number; updatedBy: string } | null;
  groups: { id: string; displayName: string; members: number; role: Role | null }[];
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const busy = fetcher.state !== 'idle';
  const roles = useFetcher<typeof action>();
  const rolesError = roles.data && 'error' in roles.data ? roles.data.error : null;
  // Mapping a group to Admin makes its members admins: that asks who you are first.
  const [admins, setAdmins] = useState(
    () => new Set(groups.filter((g) => g.role === 'admin').map((g) => g.id)),
  );
  const pick = (id: string, role: string) =>
    setAdmins((was) => {
      const next = new Set(was);
      if (role === 'admin') next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Section title="SCIM provisioning">
      <p className="max-w-[65ch] text-muted-foreground text-xs">
        Your identity provider can add people, update them and turn them off here. Turning someone
        off signs them out everywhere and disconnects their apps and the API tokens they made. Give
        it the endpoint and a token.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Endpoint</span>
        <code className="select-all break-all rounded-sm bg-card px-2 py-1 font-mono">
          {endpoint}
        </code>
        <CopyButton text={endpoint} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm">
          {token ? (
            <>
              Token made <Ago ms={token.updatedAt} /> by {token.updatedBy}.{' '}
              {now - token.updatedAt >= SCIM_TOKEN_MS
                ? 'It has expired: provisioning is off until you replace it.'
                : 'It works for a year; replace it before then.'}
            </>
          ) : (
            'No token: provisioning is off.'
          )}
        </span>
        <fetcher.Form method="post" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="scim-token" />
          <StepUpField method={stepUp} next="/team" />
          <Button size="sm" variant="outline" type="submit" disabled={busy}>
            {token ? 'Replace token' : 'Make a token'}
          </Button>
        </fetcher.Form>
        {token ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="scim-revoke" />
            <Button size="sm" variant="outline" type="submit" disabled={busy}>
              Revoke
            </Button>
          </fetcher.Form>
        ) : null}
      </div>
      {groups.length ? (
        <roles.Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="scim-roles" />
          <p className="text-sm">Groups from your identity provider</p>
          <ul className="mt-2 divide-y rounded-md border text-sm">
            {groups.map((g) => (
              <li
                key={g.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span>
                  {g.displayName}{' '}
                  <span className="text-muted-foreground text-xs">
                    {g.members} {g.members === 1 ? 'member' : 'members'}
                  </span>
                </span>
                <NativeSelect
                  name={`role:${g.id}`}
                  defaultValue={g.role ?? ''}
                  className="h-8"
                  aria-label={`Role for ${g.displayName}`}
                  onChange={(e) => pick(g.id, e.target.value)}
                >
                  <NativeSelectOption value="">Gives no role</NativeSelectOption>
                  {ROLES.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      Gives {ROLE_LABELS[r]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </li>
            ))}
          </ul>
          {admins.size ? (
            <div className="mt-2">
              <StepUpField method={stepUp} next="/team" />
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            type="submit"
            className="mt-2"
            disabled={roles.state !== 'idle'}
          >
            Save group roles
          </Button>
          {rolesError ? (
            <p role="alert" className="mt-2 text-destructive text-sm">
              {rolesError}
            </p>
          ) : null}
          <p className="mt-2 max-w-[65ch] text-muted-foreground text-xs">
            Someone in a group that gives a role has the highest role of their groups, or Viewer
            when none of theirs gives one. Their role follows changes to their groups, and the last
            active admin always stays an admin.
          </p>
        </roles.Form>
      ) : token ? (
        <p className="mt-3 text-muted-foreground text-xs">
          Groups your identity provider pushes appear here, to map to roles.
        </p>
      ) : null}
    </Section>
  );
}

/** Single sign-on: who it may add, from which domains, and whether it is the only way in. */
function SsoForm({
  issuer,
  settings,
  linked,
  stepUp,
}: {
  issuer: string;
  settings: SsoSettings;
  linked: boolean;
  stepUp: StepUpMethod | null;
}) {
  const fetcher = useFetcher<typeof action>();
  const error = fetcher.data && 'error' in fetcher.data ? fetcher.data.error : null;
  return (
    <Section title="Single sign-on">
      <p className="max-w-[65ch] text-muted-foreground text-xs">
        People can sign in through your identity provider,{' '}
        <span className="font-mono">{issuer}</span>. Someone already on the team is matched by email
        on their first sign-in.
      </p>
      <fetcher.Form method="post" className="mt-3 grid max-w-xl gap-3">
        <input type="hidden" name="intent" value="sso-settings" />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="sso-jit" className="text-sm">
            Someone not on the team
          </label>
          <NativeSelect
            id="sso-jit"
            name="jit"
            defaultValue={settings.jitRole ?? 'off'}
            className="h-8"
          >
            <NativeSelectOption value="off">Is refused</NativeSelectOption>
            {ROLES.filter((r) => r !== 'admin').map((r) => (
              <NativeSelectOption key={r} value={r}>
                Joins as {ROLE_LABELS[r]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Field label="From these email domains">
          <Input
            id="sso-domains"
            name="domains"
            defaultValue={settings.domains.join(', ')}
            placeholder="example.com, example.co.uk"
            className="h-8"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="only" value="on" defaultChecked={settings.ssoOnly} />
          Single sign-on only: turn off passwords and passkeys
        </label>
        <StepUpField method={stepUp} next="/team" />
        <div>
          <Button size="sm" variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
            Save
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </fetcher.Form>
      <p className="mt-2 max-w-[65ch] text-muted-foreground text-xs">
        With single sign-on only, your identity provider handles two-factor sign-in, and a person
        disabled there can’t sign in here once their session ends; disable them here to end it now.
        {linked
          ? ' If the provider stops working, a setup code recovers access and turns passwords back on.'
          : ' To turn passwords off, first sign in with single sign-on yourself.'}
      </p>
    </Section>
  );
}

/** Separation of duties: whether whoever started an order may also decide its approvals. */
function ApprovalSeparationForm({ separated }: { separated: boolean }) {
  const fetcher = useFetcher();
  return (
    <Section title="Approvals">
      <fetcher.Form method="post" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="intent" value="approval-separation" />
        <label htmlFor="separated" className="text-sm">
          Who started an order
        </label>
        <NativeSelect
          id="separated"
          name="separated"
          defaultValue={separated ? 'on' : 'off'}
          className="h-8"
        >
          <NativeSelectOption value="off">May approve it</NativeSelectOption>
          <NativeSelectOption value="on">Can’t approve it</NativeSelectOption>
        </NativeSelect>
        <Button size="sm" variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
          Save
        </Button>
      </fetcher.Form>
      <p className="mt-2 max-w-[65ch] text-muted-foreground text-xs">
        Separates duties: the person or API token that started an order can’t approve or reject its
        steps, so a second person always decides. Orders from channels, email and the stock review
        have no starter, and anyone with the Approver role may decide them.
      </p>
    </Section>
  );
}

/** Which roles must use two-factor sign-in; people without it are sent to set it up. */
function TwoFactorRequirementForm({
  required,
  missing,
  stepUp,
}: {
  required: TwoFactorRequirement;
  missing: number;
  stepUp: StepUpMethod | null;
}) {
  const fetcher = useFetcher<typeof action>();
  const error = fetcher.data && 'error' in fetcher.data ? fetcher.data.error : null;
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
        <StepUpField method={stepUp} next="/team" />
        <Button size="sm" variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
          Save
        </Button>
      </fetcher.Form>
      {error ? (
        <p role="alert" className="mt-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <p className="mt-2 max-w-[65ch] text-muted-foreground text-xs">
        People in these roles without two-factor sign-in can only use their Account page until they
        set it up, and can’t turn it off. API tokens aren’t affected.
        {required !== 'off' && missing
          ? ` ${missing} ${missing === 1 ? 'person hasn’t' : 'people haven’t'} set it up yet.`
          : ''}
      </p>
    </Section>
  );
}
