import { atLeast, type Principal, ROLE_LABELS } from '@orderloop/core';
import { approvals } from '@orderloop/db';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@orderloop/ui/dropdown-menu';
import { cn } from '@orderloop/ui/lib/utils';
import { eq, sql } from 'drizzle-orm';
import { Menu, MessageSquareText, Monitor, Moon, Plus, Sun, UserRound } from 'lucide-react';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLoaderData } from 'react-router';
import { AssistantPanel } from '~/components/assistant/panel';
import { Mark } from '~/components/mark';
import { AssistantProvider, useAssistant } from '~/lib/assistant';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { db } from '~/lib/env.server';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  // Until their two-factor sign-in is set up, a person sees only their Account page.
  if (me.twoFactorDue) return { pending: 0, auth: true, me, nav: false };
  const pending = await db()
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .get();
  return { pending: pending?.n ?? 0, auth: await authEnabled(), me, nav: true };
}

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/orders', label: 'Orders' },
  { to: '/approvals', label: 'Approvals', badge: true },
  { to: '/flows', label: 'Flows' },
  { to: '/back-office', label: 'Back office' },
];

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
];

function PendingCount({ n }: { n: number }) {
  return (
    <span className="rounded-sm bg-wait/15 px-1.5 py-px font-medium text-[11px] text-wait tabular">
      {n}
      <span className="sr-only"> pending</span>
    </span>
  );
}

export default function Shell() {
  return (
    <AssistantProvider>
      <ShellFrame />
    </AssistantProvider>
  );
}

/** Opens and closes the assistant, from the top bar or with ⌘J anywhere. */
function AssistantToggle() {
  const { open, setOpen, focus } = useAssistant();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (open) setOpen(false);
        else focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen, focus]);
  return (
    <button
      type="button"
      onClick={() => (open ? setOpen(false) : focus())}
      aria-pressed={open}
      title={open ? 'Close the assistant (⌘J)' : 'Ask the assistant (⌘J)'}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors',
        open
          ? 'border-foreground/25 bg-accent font-medium text-foreground'
          : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <MessageSquareText className="size-3.5" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">Assistant</span>
      <kbd className="hidden font-sans text-[11px] text-muted-foreground lg:inline">⌘J</kbd>
    </button>
  );
}

function ShellFrame() {
  const { pending, auth, me, nav: showNav } = useLoaderData<typeof loader>();
  const operator = showNav && atLeast(me.role, 'operator');
  const nav = showNav ? NAV : [];
  const theme = useTheme();
  const ThemeIcon = THEMES.find((t) => t.value === theme.choice)?.icon ?? Sun;
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {/* 3rem tall with its rule: full-height pages and the assistant subtract exactly 3rem. */}
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="flex h-[calc(3rem-1px)] items-center gap-3 px-4 sm:gap-6 sm:px-5">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 font-semibold tracking-title text-[16px]"
            aria-label="OrderLoop overview"
          >
            <Mark className="size-5" />
            <span className="hidden sm:inline">OrderLoop</span>
          </Link>
          <nav aria-label="Main" className="-mb-px hidden h-full items-stretch gap-1 md:flex">
            {nav.map(({ to, label, end, badge }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
                    isActive && 'border-foreground font-medium text-foreground',
                  )
                }
              >
                {label}
                {badge && pending > 0 ? <PendingCount n={pending} /> : null}
              </NavLink>
            ))}
          </nav>
          {/* On phones the approvals queue stays one tap away; everything else is in the menu. */}
          {pending > 0 ? (
            <NavLink
              to="/approvals"
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 text-[13px] md:hidden',
                  isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
                )
              }
            >
              Approvals <PendingCount n={pending} />
            </NavLink>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            {showNav ? <AssistantToggle /> : null}
            {operator ? (
              <Link
                to="/orders/new"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-[13px] text-primary-foreground hover:bg-primary/90 sm:px-3"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">New order</span>
              </Link>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:grid"
                aria-label={`Theme: ${THEMES.find((t) => t.value === theme.choice)?.label ?? theme.choice}`}
              >
                <ThemeIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <ThemeItems value={theme.choice} onChange={theme.setChoice} />
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Who is signed in, and the pages that belong to them and the team. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="hidden h-8 items-center gap-2 rounded-md border px-2 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground md:flex"
                aria-label={`Account: ${who(me, auth)}, ${ROLE_LABELS[me.role]}`}
              >
                <UserRound className="size-4" aria-hidden="true" />
                <span className="max-w-32 truncate">{ROLE_LABELS[me.role]}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <AccountItems me={me} auth={auth} />
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
                aria-label="Menu"
              >
                <Menu className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {nav.map(({ to, label, badge }) => (
                  <DropdownMenuItem key={to} asChild>
                    <Link to={to} className="justify-between">
                      {label}
                      {badge && pending > 0 ? <PendingCount n={pending} /> : null}
                    </Link>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <ThemeItems value={theme.choice} onChange={theme.setChoice} />
                <DropdownMenuSeparator />
                <AccountItems me={me} auth={auth} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          <Outlet />
        </main>
        {showNav ? <AssistantPanel /> : null}
      </div>
    </div>
  );
}

function ThemeItems({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (v: ThemeChoice) => void;
}) {
  return (
    <>
      <DropdownMenuLabel className="caption font-medium">Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as ThemeChoice)}>
        {THEMES.map(({ value: v, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={v} value={v}>
            <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** How the signed-in principal is named: a person's email, else how this session got in. */
const who = (me: Principal, auth: boolean) =>
  me.kind === 'user' ? (me.email ?? me.name) : auth ? 'Workspace password' : 'Sign-in is off';

/** Who is signed in, their account, the team and its audit log, and signing in or out. */
function AccountItems({ me, auth }: { me: Principal; auth: boolean }) {
  const operator = atLeast(me.role, 'operator');
  return (
    <>
      <DropdownMenuLabel className="font-normal">
        <span className="block truncate font-medium text-sm">{who(me, auth)}</span>
        <span className="text-muted-foreground text-xs">{ROLE_LABELS[me.role]}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/account">Account</Link>
      </DropdownMenuItem>
      {operator ? (
        <>
          <DropdownMenuItem asChild>
            <Link to="/team">Team and roles</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/audit">Audit log</Link>
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuSeparator />
      {auth ? (
        <DropdownMenuItem asChild>
          <a href="/logout">Sign out</a>
        </DropdownMenuItem>
      ) : operator ? (
        <DropdownMenuItem asChild>
          <Link to="/team">Set up sign-in</Link>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
