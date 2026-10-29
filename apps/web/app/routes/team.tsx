import { isRole, ROLE_LABELS, ROLES, type Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@orderloop/ui/dropdown-menu';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Ellipsis, KeyRound, UserRound } from 'lucide-react';
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
  useRevalidator,
} from 'react-router';
import { Ago } from '~/components/ago';
import { Confirm } from '~/components/confirm';
import { CopyButton } from '~/components/copy-button';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { Empty, PageHeader, Section } from '~/components/page';
import { StepUpField } from '~/components/step-up-field';
import { useAssistant } from '~/lib/assistant';
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
  assistantRouting,
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
  const [team, twoFactorRequired, separated, routing, sso, scimToken, scimGroups] =
    await Promise.all([
      listTeam(),
      twoFactorRequirement(),
      approvalSeparation(),
      assistantRouting(),
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
    routing,
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

/** The roles in words. `stacked` lists them in one column, for a rail or a half-width card. */
function RoleGuide({ stacked = false }: { stacked?: boolean }) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-3 text-sm',
        stacked ? 'max-lg:sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-4',
      )}
    >
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
 * A person's role, saved from their row through the assistant: its card says what changes, and
 * making them an admin asks who you are there first. Save shows only once the role is changed, so
 * a row at rest is just its role.
 */
export function RoleForm({ id, name, role }: { id: string; name: string; role: Role }) {
  const [chosen, setChosen] = useState<Role>(role);
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act('set_member_role', { userId: id, role: chosen });
      if (!('declined' in r)) revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RoleSelect value={role} label={`Role for ${name}`} compact onChange={setChosen} />
      {chosen !== role ? (
        <Button
          size="sm"
          variant="outline"
          aria-label={`Save role for ${name}`}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Confirm it in the assistant' : 'Save'}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-bad text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RoleSelect({
  id,
  name = 'role',
  value,
  onChange,
  label,
  compact,
}: {
  id?: string;
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
      id={id}
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
  const {
    people,
    tokens,
    me,
    now,
    twoFactorRequired,
    separated,
    routing,
    sso,
    scim,
    signInUrl,
    stepUp,
  } = useLoaderData<typeof loader>();
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
      {/* People and tokens first, then the sign-in rules; the role guide is reference, so wide
          screens keep it in a rail beside them and phones read it last. */}
      <div className="mx-auto grid max-w-page items-start gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {secret ? (
            <div
              ref={secretRef}
              tabIndex={-1}
              className="rounded-2xl border border-wait/40 bg-wait/10 p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <p className="font-medium">{secret.label}</p>
              <p className="mt-0.5 max-w-measure text-muted-foreground text-xs">
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
            description="Everyone who can sign in, with their role and last sign-in."
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
              <ul aria-label="People" className="-mx-2 flex flex-col gap-1">
                {people.map((p) => (
                  <Item
                    key={p.id}
                    asChild
                    size="sm"
                    variant={asking?.id === p.id ? 'muted' : 'default'}
                    className={cn('items-start', p.disabledAt && 'text-muted-foreground')}
                  >
                    <li>
                      <ItemMedia variant="icon" className="size-8 rounded-full bg-muted">
                        <UserRound className="text-muted-foreground" aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent className="min-w-0 basis-40 self-center">
                        <ItemTitle className="block">
                          {p.name}
                          {p.id === me.id ? (
                            <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                              you
                            </span>
                          ) : null}
                        </ItemTitle>
                        <ItemDescription className="break-all text-xs">
                          {p.email}
                          {p.twoFactorAt ? ' · two-factor' : ''}
                          {p.passwordChangeDue ? ' · temporary password' : ''}
                          {p.disabledAt ? ' · disabled' : ''}
                        </ItemDescription>
                        <ItemDescription className="text-xs">
                          Last sign-in: {p.lastLoginAt ? <Ago ms={p.lastLoginAt} /> : 'Never'}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="items-start">
                        <RoleForm
                          // Saved (here or elsewhere), the row starts again from the new role.
                          key={p.role}
                          id={p.id}
                          name={p.name}
                          role={p.role as Role}
                        />
                        <RowActions
                          id={p.id}
                          name={p.name}
                          self={p.id === me.id}
                          twoFactor={!!p.twoFactorAt}
                          disabled={!!p.disabledAt}
                          ask={ask}
                        />
                      </ItemActions>
                      {/* The question gets its own line under the person, so the name stays
                          beside what's being asked. */}
                      {asking?.id === p.id ? (
                        <Item asChild variant="outline" size="xs" className="basis-full bg-card">
                          <fetcher.Form method="post" onSubmit={() => setAsking(null)}>
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
                              <Button size="sm" variant="destructive" type="submit" disabled={busy}>
                                {ACTIONS[asking.intent]}
                              </Button>
                            </Confirm>
                          </fetcher.Form>
                        </Item>
                      ) : null}
                    </li>
                  </Item>
                ))}
              </ul>
            ) : (
              <Empty>Nobody is on the team yet.</Empty>
            )}
          </Section>

          <Section
            title="API tokens"
            description="For a system that calls the REST API, each with its own role."
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
              <ul aria-label="API tokens" className="-mx-2 flex flex-col gap-1">
                {tokens.map((t) => {
                  const state = tokenState(t, now);
                  return (
                    <Item
                      key={t.id}
                      asChild
                      size="sm"
                      className={
                        state === 'revoked' || state === 'expired'
                          ? 'text-muted-foreground'
                          : undefined
                      }
                    >
                      <li>
                        <ItemMedia variant="icon" className="size-8 rounded-full bg-muted">
                          <KeyRound className="text-muted-foreground" aria-hidden="true" />
                        </ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="flex-wrap">
                            {t.name}
                            <code className="font-mono font-normal text-muted-foreground text-xs">
                              {t.prefix}…
                            </code>
                          </ItemTitle>
                          <ItemDescription className="text-xs">
                            <span className="text-foreground">{ROLE_LABELS[t.role as Role]}</span> ·
                            by {t.createdBy} ·{' '}
                            {t.lastUsedAt ? (
                              <>
                                used <Ago ms={t.lastUsedAt} />
                              </>
                            ) : (
                              'never used'
                            )}
                            {t.revokedAt ? ' · revoked' : ''}
                            {state === 'revoked' ? null : ' · '}
                            <TokenExpiry state={state} expiresAt={t.expiresAt} />
                          </ItemDescription>
                        </ItemContent>
                        {t.revokedAt ? null : (
                          <ItemActions>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="revoke" />
                              <input type="hidden" name="id" value={t.id} />
                              <Button size="sm" variant="ghost" type="submit" disabled={busy}>
                                Revoke
                              </Button>
                            </fetcher.Form>
                          </ItemActions>
                        )}
                      </li>
                    </Item>
                  );
                })}
              </ul>
            ) : (
              <Empty>No API tokens. Systems that call the REST API need one.</Empty>
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
          <AssistantRoutingForm routing={routing} />
        </div>

        <aside aria-label="Roles" className="min-w-0">
          <Section title="Roles" description="What each role may do, for people and tokens alike.">
            <RoleGuide stacked />
          </Section>
        </aside>
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
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="add-user" />
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="add-person-email">Email</FieldLabel>
          {/* Someone else's address: keep a password manager from offering yours. */}
          <Input
            id="add-person-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="name@company.com"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="add-person-name">
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </FieldLabel>
          <Input id="add-person-name" name="name" autoComplete="off" />
        </Field>
        <Field>
          <FieldLabel htmlFor="add-person-role">Role</FieldLabel>
          <RoleSelect id="add-person-role" onChange={setRole} />
        </Field>
        {/* Making an admin is what needs proof it's you. */}
        {role === 'admin' ? <StepUpField method={stepUp} next="/team" /> : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={busy}>
            Add person
          </Button>
        </div>
      </FieldGroup>
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
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="add-token" />
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="add-token-name">Used by</FieldLabel>
          <Input id="add-token-name" name="name" required placeholder="e.g. ERP sync" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="add-token-role">Role</FieldLabel>
            <RoleSelect id="add-token-role" value="viewer" onChange={setRole} />
          </Field>
          <Field>
            <FieldLabel htmlFor="add-token-lifetime">Expires after</FieldLabel>
            <NativeSelect
              id="add-token-lifetime"
              name="lifetime"
              defaultValue={DEFAULT_LIFETIME}
              className="h-9 w-full"
            >
              {Object.entries(TOKEN_LIFETIMES).map(([k, label]) => (
                <NativeSelectOption key={k} value={k}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {/* The role is the boundary: say what this token will be able to do before it exists. */}
        <FieldDescription className="-mt-2 max-w-measure text-xs" aria-live="polite">
          A token with the {ROLE_LABELS[role].toLowerCase()} role:{' '}
          {ROLE_GUIDE[role].charAt(0).toLowerCase() + ROLE_GUIDE[role].slice(1)}
        </FieldDescription>
        <StepUpField method={stepUp} next="/team" />
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={busy}>
            Create token
          </Button>
        </div>
      </FieldGroup>
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
          <Section
            title="Create your admin account"
            description="Once it exists, everyone signs in, and you add people and API tokens here."
          >
            <Form method="post">
              <input type="hidden" name="intent" value="first-admin" />
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="first-admin-email">Email</FieldLabel>
                  <Input
                    id="first-admin-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="username"
                    placeholder="name@company.com"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="first-admin-name">
                    Name <span className="font-normal text-muted-foreground">(optional)</span>
                  </FieldLabel>
                  <Input id="first-admin-name" name="name" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="first-admin-password">Password</FieldLabel>
                  <Input
                    id="first-admin-password"
                    name="password"
                    type="password"
                    required
                    minLength={10}
                    autoComplete="new-password"
                    aria-describedby="first-admin-password-hint"
                  />
                  <FieldDescription id="first-admin-password-hint" className="text-xs">
                    At least 10 characters
                  </FieldDescription>
                </Field>
                {error ? <FieldError>{error}</FieldError> : null}
                <div>
                  <Button type="submit" disabled={creating}>
                    {creating ? 'Creating…' : 'Create account and sign in'}
                  </Button>
                </div>
              </FieldGroup>
            </Form>
          </Section>
          <Section title="Roles you can give people and tokens">
            <RoleGuide stacked />
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
    <Section
      title="SCIM provisioning"
      description="Your identity provider can add people, update them and turn them off here. Turning someone off signs them out everywhere and disconnects their apps and the API tokens they made. Give it the endpoint and a token."
    >
      <FieldGroup className="gap-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Endpoint</span>
          <code className="min-w-0 select-all break-all rounded-sm bg-muted px-2 py-1 font-mono">
            {endpoint}
          </code>
          <CopyButton text={endpoint} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <roles.Form method="post">
            <input type="hidden" name="intent" value="scim-roles" />
            <p className="font-medium text-sm">Groups from your identity provider</p>
            <ul aria-label="Groups" className="-mx-2 mt-2 flex flex-col gap-1">
              {groups.map((g) => (
                <Item key={g.id} asChild size="xs" className="flex-nowrap">
                  <li>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="block truncate font-normal">{g.displayName}</ItemTitle>
                      <ItemDescription className="text-xs">
                        {g.members} {g.members === 1 ? 'member' : 'members'}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
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
                    </ItemActions>
                  </li>
                </Item>
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
            {rolesError ? <FieldError className="mt-2">{rolesError}</FieldError> : null}
            <FieldDescription className="mt-2 max-w-measure text-xs">
              Someone in a group that gives a role has the highest role of their groups, or Viewer
              when none of theirs gives one. Their role follows changes to their groups, and the
              last active admin always stays an admin.
            </FieldDescription>
          </roles.Form>
        ) : token ? (
          <p className="text-muted-foreground text-xs">
            Groups your identity provider pushes appear here, to map to roles.
          </p>
        ) : null}
      </FieldGroup>
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
    <Section
      title="Single sign-on"
      description={
        <>
          People can sign in through your identity provider,{' '}
          <span className="font-mono">{issuer}</span>. Someone already on the team is matched by
          email on their first sign-in.
        </>
      }
    >
      <fetcher.Form method="post" className="max-w-xl">
        <input type="hidden" name="intent" value="sso-settings" />
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="sso-jit">Someone not on the team</FieldLabel>
            <NativeSelect
              id="sso-jit"
              name="jit"
              defaultValue={settings.jitRole ?? 'off'}
              className="h-9 w-full"
            >
              <NativeSelectOption value="off">Is refused</NativeSelectOption>
              {ROLES.filter((r) => r !== 'admin').map((r) => (
                <NativeSelectOption key={r} value={r}>
                  Joins as {ROLE_LABELS[r]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="sso-domains">From these email domains</FieldLabel>
            <Input
              id="sso-domains"
              name="domains"
              defaultValue={settings.domains.join(', ')}
              placeholder="example.com, example.co.uk"
            />
          </Field>
          <Field orientation="horizontal">
            <input
              id="sso-only"
              type="checkbox"
              name="only"
              value="on"
              defaultChecked={settings.ssoOnly}
            />
            <FieldContent>
              <FieldLabel htmlFor="sso-only" className="font-normal">
                Single sign-on only: turn off passwords and passkeys
              </FieldLabel>
              <FieldDescription className="text-xs">
                With single sign-on only, your identity provider handles two-factor sign-in, and a
                person disabled there can’t sign in here once their session ends; disable them here
                to end it now.
                {linked
                  ? ' If the provider stops working, a setup code recovers access and turns passwords back on.'
                  : ' To turn passwords off, first sign in with single sign-on yourself.'}
              </FieldDescription>
            </FieldContent>
          </Field>
          <StepUpField method={stepUp} next="/team" />
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button size="sm" variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
              Save
            </Button>
          </div>
        </FieldGroup>
      </fetcher.Form>
    </Section>
  );
}

/** Separation of duties: whether whoever started an order may also decide its approvals. */
function ApprovalSeparationForm({ separated }: { separated: boolean }) {
  const [chosen, setChosen] = useState(separated ? 'on' : 'off');
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved through the assistant: its card says who may then approve what.
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act('set_approval_separation', { on: chosen === 'on' });
      if (!('declined' in r)) revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Approvals"
      description="Whether whoever started an order may also decide its approvals."
    >
      <div className="max-w-xl">
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="separated">Who started an order</FieldLabel>
            <NativeSelect
              id="separated"
              name="separated"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="h-9 w-full"
            >
              <NativeSelectOption value="off">May approve it</NativeSelectOption>
              <NativeSelectOption value="on">Can’t approve it</NativeSelectOption>
            </NativeSelect>
            <FieldDescription className="text-xs">
              Separates duties: the person or API token that started an order can’t approve or
              reject its steps, so a second person always decides. Orders from channels, email and
              the stock review have no starter, and anyone with the Approver role may decide them.
            </FieldDescription>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || chosen === (separated ? 'on' : 'off')}
              onClick={() => void save()}
            >
              {busy ? 'Confirm it in the assistant' : 'Save'}
            </Button>
          </div>
        </FieldGroup>
      </div>
    </Section>
  );
}

/** Whether the assistant runs exact requests without the chat model, to save model cost. */
function AssistantRoutingForm({ routing }: { routing: boolean }) {
  const [chosen, setChosen] = useState(routing ? 'on' : 'off');
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved through the assistant: its card says what changes.
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act('set_assistant_routing', { on: chosen === 'on' });
      if (!('declined' in r)) revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Assistant"
      description="Whether a request that is one exact call skips the chat model."
    >
      <div className="max-w-xl">
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="routing">Exact requests</FieldLabel>
            <NativeSelect
              id="routing"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="h-9 w-full"
            >
              <NativeSelectOption value="off">Always use the chat model</NativeSelectOption>
              <NativeSelectOption value="on">
                Run on fixed rules when the decision model is sure
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription className="text-xs">
              Saves model cost. A request such as “cancel this order” or “list open carts” is read
              by fixed rules; the decision model checks that the request asks for exactly that, and
              only then does it run without the chat model. Anything else goes to the chat model as
              before, and actions still stop at their confirm card. Page buttons never use a model
              either way.
            </FieldDescription>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || chosen === (routing ? 'on' : 'off')}
              onClick={() => void save()}
            >
              {busy ? 'Confirm it in the assistant' : 'Save'}
            </Button>
          </div>
        </FieldGroup>
      </div>
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
    <Section
      title="Two-factor sign-in"
      description="Which roles must use two-factor sign-in; people without it are sent to set it up."
    >
      <fetcher.Form method="post" className="max-w-xl">
        <input type="hidden" name="intent" value="two-factor-requirement" />
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="tf-required">Required for</FieldLabel>
            <NativeSelect
              id="tf-required"
              name="required"
              defaultValue={required}
              className="h-9 w-full"
            >
              {Object.entries(TWO_FACTOR_REQUIREMENTS).map(([k, label]) => (
                <NativeSelectOption key={k} value={k}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription className="text-xs">
              People in these roles without two-factor sign-in can only use their Account page until
              they set it up, and can’t turn it off. API tokens aren’t affected.
              {required !== 'off' && missing
                ? ` ${missing} ${missing === 1 ? 'person hasn’t' : 'people haven’t'} set it up yet.`
                : ''}
            </FieldDescription>
          </Field>
          <StepUpField method={stepUp} next="/team" />
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button size="sm" variant="outline" type="submit" disabled={fetcher.state !== 'idle'}>
              Save
            </Button>
          </div>
        </FieldGroup>
      </fetcher.Form>
    </Section>
  );
}
