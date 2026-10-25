// The roles subpath alone: the core barrel would bring zod into every page.
import { atLeast, type Principal, ROLE_LABELS } from '@orderloop/core/roles';
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
import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@orderloop/ui/sheet';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  Ellipsis,
  LayoutDashboard,
  MessageSquareText,
  Monitor,
  Moon,
  Plus,
  ReceiptText,
  Stamp,
  Sun,
  UserRound,
  Workflow,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
  useLocation,
  useNavigation,
} from 'react-router';
import { Mark } from '~/components/mark';
import { AssistantProvider, useAssistant } from '~/lib/assistant';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { db } from '~/lib/env.server';
import { PluginsProvider } from '~/lib/plugins';
import { pluginManifests } from '~/lib/plugins.server';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  // Until their two-factor sign-in is set up, a person sees only their Account page.
  if (me.twoFactorDue || me.passwordChangeDue)
    return { pending: 0, auth: true, me, nav: false, plugins: [] };
  const [pending, admins, auth, plugins] = await Promise.all([
    db()
      .select({ n: sql<number>`count(*)` })
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
      .get(),
    // Who to ask when a page needs a higher role: up to three active admins.
    atLeast(me.role, 'admin')
      ? []
      : db()
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
          .orderBy(users.name)
          .limit(3),
    authEnabled(),
    // Installed plugins: their nodes in the editor, their pages in the nav.
    pluginManifests(),
  ]);
  return { pending: pending?.n ?? 0, auth, me, nav: true, admins, plugins };
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

type NavItem = { to: string; label: string; end?: boolean; badge?: boolean; document?: boolean };

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/orders', label: 'Orders' },
  { to: '/carts', label: 'Carts' },
  { to: '/approvals', label: 'Approvals', badge: true },
  { to: '/flows', label: 'Flows' },
  { to: '/commerce', label: 'Commerce' },
];

/** Phones: the pages an operator reaches for most, as tabs; the rest of NAV is under More. */
const TABS: { to: string; label: string; icon: typeof Sun; end?: boolean; badge?: boolean }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/orders', label: 'Orders', icon: ReceiptText },
  { to: '/approvals', label: 'Approvals', icon: Stamp, badge: true },
  { to: '/flows', label: 'Flows', icon: Workflow },
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
  const { plugins } = useLoaderData<typeof loader>();
  return (
    <PluginsProvider plugins={plugins}>
      <AssistantProvider>
        <ShellFrame />
      </AssistantProvider>
    </PluginsProvider>
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
        'hit-area inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-4xl border px-3 text-[13px] transition-colors md:h-8 md:min-w-0',
        open
          ? 'border-foreground/25 bg-accent font-medium text-foreground'
          : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <MessageSquareText className="size-3.5" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only md:max-lg:sr-only">Assistant</span>
      <kbd className="hidden font-sans text-[11px] text-muted-foreground lg:fine:inline">⌘J</kbd>
    </button>
  );
}

/** True once a navigation has taken longer than `after` ms; quick ones never flash a cue. */
function useSlowNavigation(after = 400) {
  const loading = useNavigation().state === 'loading';
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), after);
    return () => window.clearTimeout(t);
  }, [loading, after]);
  return slow;
}

/** Under the top bar while a page is slow to arrive; on a phone the old page stays readable. */
function PendingBar() {
  const slow = useSlowNavigation();
  return slow ? (
    <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden" aria-hidden="true">
      <div className="ol-pending h-full w-2/5 bg-link" />
    </div>
  ) : null;
}

function ShellFrame() {
  const slow = useSlowNavigation();
  const { pending, auth, me, nav: showNav, plugins } = useLoaderData<typeof loader>();
  const operator = showNav && atLeast(me.role, 'operator');
  // A plugin's pages are served by its own Worker, so its links load a whole document.
  const nav: NavItem[] = showNav
    ? [
        ...NAV,
        ...plugins
          .filter((p) => atLeast(me.role, p.pageRole))
          .flatMap((p) => p.nav.map((n) => ({ to: n.path, label: n.label, document: true }))),
      ]
    : [];
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
      {/* 3rem tall with its rule, under the status bar's inset: full-height pages and the assistant
          subtract --shell-h (app.css). */}
      <header className="sticky top-0 z-40 border-b bg-background pt-safe-0">
        <div className="flex h-[calc(3rem-1px)] items-center gap-3 px-safe-4 sm:gap-6 sm:px-safe-5">
          <Link
            to="/"
            className="hit-area -mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 font-semibold tracking-title text-[16px]"
            aria-label="OrderLoop overview"
          >
            <Mark className="size-5" />
            <span className="hidden sm:inline md:max-lg:hidden">OrderLoop</span>
          </Link>
          {/* Tablets in portrait run out of width before the links do: the row scrolls, not wraps. */}
          <nav
            aria-label="Main"
            className="-mb-px hidden h-full min-w-0 snap-x items-stretch gap-1 overflow-x-auto [scrollbar-width:none] md:flex md:max-lg:pr-6 md:max-lg:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]"
          >
            {nav.map(({ to, label, end, badge, document }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                reloadDocument={document}
                className={({ isActive }) =>
                  cn(
                    'flex snap-start items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-[13px] transition-colors',
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
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            {showNav ? <AssistantToggle /> : null}
            {operator ? (
              <Link
                to="/orders/new"
                className="hit-area inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-4xl bg-primary px-3 font-medium text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 sm:px-3 md:h-8 md:min-w-0"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span className="sr-only sm:not-sr-only md:max-lg:sr-only">New order</span>
              </Link>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="hit-area hidden size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:grid data-[state=open]:bg-accent data-[state=open]:text-foreground"
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
                className="hit-area hidden h-8 items-center gap-2 rounded-4xl border px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex data-[state=open]:bg-accent data-[state=open]:text-foreground"
                aria-label={`Account: ${who(me, auth)}, ${ROLE_LABELS[me.role]}`}
              >
                <UserRound className="size-4" aria-hidden="true" />
                <span className="max-w-32 truncate md:max-lg:sr-only">
                  {me.kind === 'user' ? me.name : ROLE_LABELS[me.role]}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <AccountItems me={me} auth={auth} />
              </DropdownMenuContent>
            </DropdownMenu>
            {/* Signing out is a POST; the account menu's item submits this. */}
            <form id="sign-out" method="post" action="/logout" hidden />
          </div>
        </div>
        <PendingBar />
      </header>
      <div className="flex min-h-0 flex-1">
        <main
          id="main"
          tabIndex={-1}
          aria-busy={slow || undefined}
          className="min-w-0 flex-1 pb-[var(--tabbar-h)] outline-none md:pb-0"
        >
          <Outlet />
        </main>
        {showNav ? <LazyAssistantPanel /> : null}
      </div>
      <TabBar nav={nav} pending={pending} />
    </div>
  );
}

/**
 * Phones: the main pages as tabs along the bottom, in thumb reach and clear of the home indicator,
 * and More for everything else. Wider screens have the links in the top bar instead.
 */
function TabBar({ nav, pending }: { nav: NavItem[]; pending: number }) {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  // A link in the sheet closes it by navigating; so does the back button (pathname is the trigger).
  useEffect(() => setMore(false), [pathname]);
  const tabs = nav.length ? TABS : [];
  const inTab = tabs.some((t) =>
    t.end ? pathname === t.to : pathname === t.to || pathname.startsWith(`${t.to}/`),
  );
  const item =
    'relative flex flex-col items-center justify-center gap-0.5 text-[11px] transition-colors short:gap-0';
  const state = (active: boolean) =>
    active
      ? 'font-medium text-foreground before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:bg-foreground'
      : 'text-muted-foreground';
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 h-[var(--tabbar-h)] border-t bg-background px-safe-0 pb-[var(--safe-bottom)] md:hidden"
      >
        <ul
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }}
        >
          {tabs.map(({ to, label, icon: Icon, end, badge }) => (
            <li key={to} className="contents">
              <NavLink to={to} end={end} className={({ isActive }) => cn(item, state(isActive))}>
                <span className="relative">
                  <Icon className="size-5" aria-hidden="true" />
                  {badge && pending > 0 ? (
                    <span className="absolute -top-1.5 left-3.5 min-w-4 rounded-sm bg-wait px-1 text-center font-medium text-[10px] text-background leading-4 tabular">
                      {pending > 99 ? '99+' : pending}
                    </span>
                  ) : null}
                </span>
                <span className="short:sr-only">
                  {label}
                  {badge && pending > 0 ? (
                    <span className="sr-only">, {pending} pending</span>
                  ) : null}
                </span>
              </NavLink>
            </li>
          ))}
          <li className="contents">
            <button
              type="button"
              onClick={() => setMore(true)}
              aria-haspopup="dialog"
              aria-expanded={more}
              className={cn(item, state(more || !inTab))}
            >
              <Ellipsis className="size-5" aria-hidden="true" />
              <span className="short:sr-only">More</span>
            </button>
          </li>
        </ul>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="gap-0 md:hidden">
          <MoreMenu nav={nav.filter((n) => !TABS.some((t) => t.to === n.to))} pending={pending} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The More sheet: the pages without a tab, the theme, and the account's pages. */
function MoreMenu({ nav, pending }: { nav: NavItem[]; pending: number }) {
  const { me, auth } = useLoaderData<typeof loader>();
  const theme = useTheme();
  const admin = atLeast(me.role, 'admin');
  const row =
    'flex min-h-11 items-center justify-between gap-3 rounded-md px-3 text-[15px] hover:bg-accent aria-[current=page]:font-medium';
  const links: NavItem[] = [
    ...nav,
    { to: '/account', label: 'Account' },
    ...(admin
      ? [
          { to: '/team', label: 'Team and roles' },
          { to: '/audit', label: 'Audit log' },
          { to: '/plugins', label: 'Plugins' },
        ]
      : []),
  ];
  return (
    <>
      <div className="border-b px-4 pt-4 pb-3 pr-14">
        <SheetTitle className="truncate text-[15px]">{who(me, auth)}</SheetTitle>
        <SheetDescription className="text-xs">{ROLE_LABELS[me.role]}</SheetDescription>
      </div>
      <ul className="p-2">
        {links.map(({ to, label, end, badge, document }) => (
          <li key={to}>
            <NavLink to={to} end={end} reloadDocument={document} className={row}>
              {label}
              {badge && pending > 0 ? <PendingCount n={pending} /> : null}
            </NavLink>
          </li>
        ))}
      </ul>
      <fieldset className="border-t px-4 pt-3 pb-3">
        <legend className="caption float-left mb-2 w-full font-medium">Theme</legend>
        <Segmented
          aria-label="Theme"
          value={theme.choice}
          onValueChange={(v) => theme.setChoice(v as typeof theme.choice)}
          className="clear-left grid w-full"
        >
          {THEMES.map(({ value, label, icon: Icon }) => (
            <SegmentedItem key={value} value={value} className="min-h-10">
              <Icon aria-hidden="true" />
              {value === 'system' ? 'System' : label}
            </SegmentedItem>
          ))}
        </Segmented>
      </fieldset>
      {auth || admin ? (
        <div className="border-t p-2">
          {auth ? (
            <form method="post" action="/logout">
              <button type="submit" className={cn(row, 'w-full text-left')}>
                Sign out
              </button>
            </form>
          ) : (
            <Link to="/team" className={row}>
              Set up sign-in
            </Link>
          )}
        </div>
      ) : null}
    </>
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
          <DropdownMenuItem asChild>
            <Link to="/plugins">Plugins</Link>
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuSeparator />
      {auth ? (
        <DropdownMenuItem asChild>
          {/* The form sits outside the menu, which unmounts as it closes. */}
          <button type="submit" form="sign-out" className="w-full">
            Sign out
          </button>
        </DropdownMenuItem>
      ) : admin ? (
        <DropdownMenuItem asChild>
          <Link to="/team">Set up sign-in</Link>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
