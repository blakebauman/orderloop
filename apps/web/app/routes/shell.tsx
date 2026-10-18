import { atLeast, type Principal, ROLE_LABELS } from '@orderloop/core';
import { approvals, users } from '@orderloop/db';
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Menu, MessageSquareText, Monitor, Moon, Plus, Sun, UserRound } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
} from 'react-router';
import { Mark } from '~/components/mark';
import { AssistantProvider, useAssistant } from '~/lib/assistant';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { db } from '~/lib/env.server';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  // Until their two-factor sign-in is set up, a person sees only their Account page.
  if (me.twoFactorDue || me.passwordChangeDue) return { pending: 0, auth: true, me, nav: false };
  const pending = await db()
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .get();
  // Who to ask when a page needs a higher role: up to three active admins.
  const admins = atLeast(me.role, 'admin')
    ? []
    : await db()
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
        .orderBy(users.name)
        .limit(3);
  return { pending: pending?.n ?? 0, auth: await authEnabled(), me, nav: true, admins };
}

/**
 * The assistant (with its markdown renderer) is a large chunk most page views never use: it loads
 * on first open, and is fetched ahead while the browser is idle so opening it stays instant.
 */
const loadPanel = () => import('~/components/assistant/panel');
const AssistantPanel = lazy(() => loadPanel().then((m) => ({ default: m.AssistantPanel })));

/** Mounts the assistant panel once it has been opened, and preloads it when the page is idle. */
function LazyAssistantPanel() {
  const { open } = useAssistant();
  const [wanted, setWanted] = useState(open);
  useEffect(() => {
    if (open) setWanted(true);
  }, [open]);
  useEffect(() => {
    const preload = () => void loadPanel();
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(preload, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(preload, 2000);
    return () => clearTimeout(t);
  }, []);
  return wanted ? (
    <Suspense fallback={null}>
      <AssistantPanel />
    </Suspense>
  ) : null;
}

/** The shell refreshes on a page's own `revalidate()` (live pages) at most this often. */
const BACKGROUND_REFRESH_MS = 15_000;
let lastBackgroundRefresh = 0;

/**
 * Navigations and form posts refresh the shell as usual. A page revalidating itself as its live
 * data moves (the order page does, every second or two) only refreshes the shell's badge now and
 * then, rather than re-reading the session and approvals on every push.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const background = !formMethod && currentUrl.href === nextUrl.href;
  if (!background) return defaultShouldRevalidate;
  const now = Date.now();
  if (now - lastBackgroundRefresh < BACKGROUND_REFRESH_MS) return false;
  lastBackgroundRefresh = now;
  return defaultShouldRevalidate;
}

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/orders', label: 'Orders' },
  { to: '/approvals', label: 'Approvals', badge: true },
  { to: '/flows', label: 'Flows' },
  { to: '/commerce', label: 'Commerce' },
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
        'inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors md:h-8 md:min-w-0',
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
            className="-mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 font-semibold tracking-title text-[16px]"
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
                    'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] transition-colors',
                    isActive
                      ? 'border-foreground font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:border-rule hover:text-foreground',
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
                className="inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 font-medium text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 sm:px-3 md:h-8 md:min-w-0"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">New order</span>
              </Link>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="hidden size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:grid data-[state=open]:bg-accent data-[state=open]:text-foreground"
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
                className="hidden h-8 items-center gap-2 rounded-md border px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex data-[state=open]:bg-accent data-[state=open]:text-foreground"
                aria-label={`Account: ${who(me, auth)}, ${ROLE_LABELS[me.role]}`}
              >
                <UserRound className="size-4" aria-hidden="true" />
                <span className="max-w-32 truncate">
                  {me.kind === 'user' ? me.name : ROLE_LABELS[me.role]}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <AccountItems me={me} auth={auth} />
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="grid size-10 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden data-[state=open]:bg-accent data-[state=open]:text-foreground"
                aria-label="Menu"
              >
                <Menu className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {nav.map(({ to, label, end, badge }) => (
                  <DropdownMenuItem key={to} asChild>
                    <NavLink
                      to={to}
                      end={end}
                      className="justify-between aria-[current=page]:font-medium"
                    >
                      {label}
                      {badge && pending > 0 ? <PendingCount n={pending} /> : null}
                    </NavLink>
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
        {showNav ? <LazyAssistantPanel /> : null}
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
  const admin = atLeast(me.role, 'admin');
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
      {admin ? (
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
      ) : admin ? (
        <DropdownMenuItem asChild>
          <Link to="/team">Set up sign-in</Link>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
