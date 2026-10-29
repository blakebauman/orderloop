// The roles subpath alone: the core barrel would bring zod into every page.
import { atLeast, type Principal, ROLE_LABELS } from '@orderloop/core/roles';
import { users } from '@orderloop/db';
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@orderloop/ui/sidebar';
import { TooltipProvider } from '@orderloop/ui/tooltip';
import { and, eq, isNull } from 'drizzle-orm';
import {
  Blocks,
  ChevronsUpDown,
  ChevronUp,
  Ellipsis,
  Gauge,
  LayoutDashboard,
  MessageSquareText,
  Monitor,
  Moon,
  Package,
  Plus,
  Puzzle,
  ReceiptText,
  ScrollText,
  ShoppingCart,
  Stamp,
  Store,
  Sun,
  UserRound,
  UsersRound,
  Workflow,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
} from 'react-router';
import { Mark } from '~/components/mark';
import { AssistantProvider, useAssistant } from '~/lib/assistant';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { useMedia, useShortcutLabel } from '~/lib/device';
import { db } from '~/lib/env.server';
import { pendingApprovalCounts } from '~/lib/orders.server';
import { PluginsProvider } from '~/lib/plugins';
import { pluginManifests } from '~/lib/plugins.server';
import { pageShortcut } from '~/lib/shortcuts';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

/** The sidebar as it was left (shadcn's `sidebar_state` cookie), so the server draws it right. */
const sidebarOpenFrom = (request: Request) =>
  !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(request.headers.get('Cookie') ?? '');

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const sidebarOpen = sidebarOpenFrom(request);
  // Until their two-factor sign-in is set up, a person sees only their Account page.
  if (me.twoFactorDue || me.passwordChangeDue)
    return { pending: 0, auth: true, me, nav: false, plugins: [], sidebarOpen };
  const [pending, admins, auth, plugins] = await Promise.all([
    // Only what a decision here can resume: approvals on recorded orders aren't owed by anyone.
    pendingApprovalCounts(),
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
  return { pending: pending.live, auth, me, nav: true, admins, plugins, sidebarOpen };
}

/**
 * The assistant (with its markdown renderer) is a large chunk most page views never use: it loads
 * on first open, and is fetched ahead while the browser is idle so opening it stays instant.
 */
const loadPanel = () => import('~/components/assistant/panel');
const AssistantPanel = lazy(() => loadPanel().then((m) => ({ default: m.AssistantPanel })));

/** Mounts the assistant panel once it has been opened, and preloads it when the page is idle. */
function LazyAssistantPanel() {
  // A page's edit goes through the assistant too, so it mounts the panel (closed) to send it.
  const { open, acts } = useAssistant();
  const [wanted, setWanted] = useState(open);
  useEffect(() => {
    if (open || acts.length) setWanted(true);
  }, [open, acts.length]);
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

type NavItem = {
  to: string;
  label: string;
  icon: typeof Sun;
  end?: boolean;
  badge?: boolean;
  document?: boolean;
  /** The sidebar group it heads or belongs to; the day's work has none. */
  section?: 'Build' | 'Reference';
  /** A plugin's page, under its own heading. */
  plugin?: boolean;
};

/**
 * In this order everywhere: the day's work, then building, then reference pages (and plugins'),
 * then the workspace's.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/orders', label: 'Orders', icon: ReceiptText },
  { to: '/approvals', label: 'Approvals', icon: Stamp, badge: true },
  { to: '/carts', label: 'Carts', icon: ShoppingCart },
  { to: '/flows', label: 'Flows', icon: Workflow, section: 'Build' },
  { to: '/commerce', label: 'Commerce', icon: Store, section: 'Reference' },
  { to: '/catalog', label: 'Catalog', icon: Package, section: 'Reference' },
  { to: '/performance', label: 'Performance', icon: Gauge, section: 'Reference' },
];

/**
 * Phones are for keeping up and deciding: the day's work as tabs, in NAV's order. Flows (which a
 * phone only reviews) and the rest are under More.
 */
const TABS = NAV.filter((n) => !n.section);

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
];

/** Past two digits a count is 99+, everywhere it's shown. */
const countLabel = (n: number) => (n > 99 ? '99+' : String(n));

/** The workspace's own pages, for admins: the sidebar's last group, and More's on a phone. */
const WORKSPACE: NavItem[] = [
  { to: '/team', label: 'Team and roles', icon: UsersRound },
  { to: '/audit', label: 'Audit log', icon: ScrollText },
  { to: '/plugins', label: 'Plugins', icon: Puzzle },
];

/** Approvals waiting on someone: the bar's one call for attention, filled in `wait`. */
function PendingCount({ n, hidden }: { n: number; hidden?: boolean }) {
  return (
    <span
      aria-hidden={hidden || undefined}
      className="min-w-4 rounded-full bg-wait px-1.5 text-center font-medium text-2xs text-background leading-4 tabular"
    >
      {countLabel(n)}
      {hidden ? null : <span className="sr-only"> pending</span>}
    </span>
  );
}

/** Go-to keys: G, then a letter. */
const GO: { key: string; to: string; label: string }[] = [
  { key: 'h', to: '/', label: 'Overview' },
  { key: 'o', to: '/orders', label: 'Orders' },
  { key: 'a', to: '/approvals', label: 'Approvals' },
  { key: 'c', to: '/carts', label: 'Carts' },
  { key: 'f', to: '/flows', label: 'Flows' },
  { key: 'p', to: '/performance', label: 'Performance' },
];

/**
 * G then a letter goes to a page; ? lists the shortcuts. Page shortcuts' rules apply (not while
 * typing or with a menu open), and the listener runs first, so a page's own F or J never sees the
 * letter that finished a G.
 */
function useGoKeys(onHelp: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!pageShortcut(e)) {
        armed = 0;
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        armed = 0;
        onHelp();
        return;
      }
      const go = Date.now() - armed < 1500 ? GO.find((g) => g.key === e.key) : undefined;
      if (go) {
        e.preventDefault();
        e.stopImmediatePropagation();
        armed = 0;
        navigate(go.to);
        return;
      }
      armed = e.key === 'g' ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate, onHelp]);
}

function Keys({ keys, sep = 'then' }: { keys: string[]; sep?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      {keys.map((k, i) => (
        <span key={k} className="contents">
          {i ? sep : null}
          <kbd className="min-w-5 rounded-sm bg-muted px-1 py-0.5 text-center font-sans text-foreground text-xs">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/** Every keyboard shortcut, from ? or the account menu. */
function ShortcutsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const assistant = useShortcutLabel('J');
  const sidebar = useShortcutLabel('\\');
  const save = useShortcutLabel('S');
  const send = useShortcutLabel('Enter');
  const row = 'flex items-center justify-between gap-4 py-1.5 text-sm';
  const group = (title: string, rows: [string, string[], string?][]) => (
    <section className="px-4 pt-3 pb-2">
      <h3 className="caption mb-1">{title}</h3>
      <ul>
        {rows.map(([what, keys, sep]) => (
          <li key={what} className={row}>
            {what}
            <Keys keys={keys} sep={sep} />
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 overflow-y-auto">
        <div className="border-b px-4 pt-4 pb-3 pr-14">
          <SheetTitle className="font-semibold text-base tracking-title">
            Keyboard shortcuts
          </SheetTitle>
          <SheetDescription className="text-xs">
            Single keys work outside fields, with no menu open.
          </SheetDescription>
        </div>
        {group('Everywhere', [
          ['Open or close the assistant', [assistant]],
          ['Collapse or expand the sidebar', [sidebar]],
          ...GO.map((g): [string, string[], string?] => [
            `Go to ${g.label}`,
            ['G', g.key.toUpperCase()],
          ]),
          ['This list', ['?']],
        ])}
        {group('On a page', [
          ['Search orders (Orders)', ['/']],
          ['Step through approvals (Approvals)', ['J', 'K'], 'or'],
          ['Expand the flow (a flow)', ['F']],
          ['Save the flow (flow editor)', [save]],
          ['Start the order (New order)', [send]],
        ])}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The shell's colour changes, named so they leave the focus outline alone: `transition-colors`
 * would fade the outline in from the text colour.
 */
const tint = 'transition-[color,background-color,border-color]';

/**
 * The page a link should read as current: where a navigation is heading (so the tab you chose
 * marks at once, even when the page is slow), else where you are.
 */
function useCurrentPath() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  return navigation.state === 'loading' && !navigation.formMethod
    ? navigation.location.pathname
    : pathname;
}

const isAt = (path: string, { to, end }: { to: string; end?: boolean }) =>
  end ? path === to : path === to || path.startsWith(`${to}/`);

export default function Shell() {
  const { plugins } = useLoaderData<typeof loader>();
  return (
    <PluginsProvider plugins={plugins}>
      <AssistantProvider>
        <TooltipProvider>
          <ShellFrame />
        </TooltipProvider>
      </AssistantProvider>
    </PluginsProvider>
  );
}

/** Opens and closes the assistant, from the top bar or with ⌘J (Ctrl+J) anywhere. */
function AssistantToggle() {
  const { open, setOpen, focus } = useAssistant();
  const shortcut = useShortcutLabel('J');
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
      aria-keyshortcuts="Meta+J Control+J"
      title={open ? `Close the assistant (${shortcut})` : `Ask the assistant (${shortcut})`}
      className={cn(
        'hit-area inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-4xl border px-3 text-ui md:h-8 md:min-w-0',
        tint,
        open
          ? 'border-foreground/25 bg-accent font-medium text-foreground'
          : 'border-input bg-input/30 text-muted-foreground hover:bg-input/50 hover:text-foreground',
      )}
    >
      <MessageSquareText className="size-3.5" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">Assistant</span>
      <span
        aria-hidden="true"
        className="hidden font-sans text-2xs text-muted-foreground xl:fine:inline"
      >
        <kbd className="font-sans">{shortcut}</kbd>
      </span>
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

/** Canvas pages, whose graph wants the width: the flow editor and an order. */
const railFor = (path: string) =>
  /^\/flows\/[^/]+$/.test(path) ||
  (/^\/orders\/[^/]+$/.test(path) && path !== '/orders/new' && path !== '/orders/scenarios');

/** Past this many, a group of plugins' pages shows the first few and folds the rest. */
const PLUGIN_FOLD = 6;

/** Rows a finger can hit: 44px on touch, the preset's 36px otherwise. */
const ROW = 'touch:h-11';

/**
 * Every page, from md, on shadcn's Sidebar (`@orderloop/ui/sidebar`): the brand row on the
 * header's line, whose mark is the toggle (⌘\); the day's work; Build, Reference, From plugins and,
 * for admins, Workspace; the account at its foot.
 */
function AppSidebar({
  groups,
  pending,
  path,
  onShortcuts,
}: {
  groups: { title?: string; items: NavItem[] }[];
  pending: number;
  path: string;
  onShortcuts: () => void;
}) {
  const { me, auth } = useLoaderData<typeof loader>();
  const { state } = useSidebar();
  const expanded = state === 'expanded';
  const shortcut = useShortcutLabel('\\');
  const [allPlugins, setAllPlugins] = useState(false);
  return (
    <Sidebar className="vt-sidebar pl-(--safe-left)">
      {/* On the header's line: its height, its inset and its rule. */}
      <SidebarHeader className="h-(--shell-h) shrink-0 justify-end gap-0 border-sidebar-border border-b px-2 pt-safe-0 pb-0">
        <div className="flex h-[calc(3rem-1px)] items-center gap-2 px-0.5">
          <SidebarTrigger
            aria-label="Sidebar"
            aria-controls="sidebar-nav"
            aria-keyshortcuts="Meta+\ Control+\"
            title={`${expanded ? 'Collapse' : 'Expand'} the sidebar (${shortcut})`}
            className="hit-area"
          >
            <Mark className="size-5" />
          </SidebarTrigger>
          <span className="truncate font-semibold text-base tracking-title transition-opacity duration-(--motion-instant) @max-[8rem]:opacity-0">
            OrderLoop
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent id="sidebar-nav" role="navigation" aria-label="Main" className="py-1">
        {groups.map(({ title, items }) => {
          const plugins = !!items[0]?.plugin && items.length > PLUGIN_FOLD;
          const shown =
            plugins && !allPlugins
              ? items.filter((it, i) => i < PLUGIN_FOLD - 1 || isAt(path, it))
              : items;
          const id = title ? `sidebar-${title.toLowerCase().replace(/\W+/g, '-')}` : undefined;
          return (
            <SidebarGroup key={title ?? 'work'} className="py-1">
              {title ? (
                <SidebarGroupLabel id={id} className="caption">
                  {title}
                </SidebarGroupLabel>
              ) : null}
              <SidebarMenu aria-labelledby={id}>
                {shown.map(({ to, label, icon: Icon, end, badge, document }) => {
                  const here = isAt(path, { to, end });
                  const counted = badge && pending > 0;
                  return (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton
                        asChild
                        isActive={here}
                        tooltip={counted ? `${label}, ${countLabel(pending)}` : label}
                        className={ROW}
                      >
                        <NavLink
                          to={to}
                          end={end}
                          reloadDocument={document}
                          viewTransition
                          aria-current={here ? 'page' : undefined}
                        >
                          <Icon
                            className={here ? undefined : 'text-muted-foreground'}
                            aria-hidden="true"
                          />
                          {counted ? (
                            // As a rail, the count becomes a dot on the icon.
                            <span
                              aria-hidden="true"
                              className="absolute top-1.5 left-[1.375rem] hidden size-2 rounded-full bg-wait ring-2 ring-sidebar @max-[8rem]:block"
                            />
                          ) : null}
                          <span>
                            {label}
                            {counted ? <span className="sr-only">, {pending} pending</span> : null}
                          </span>
                        </NavLink>
                      </SidebarMenuButton>
                      {counted ? (
                        <SidebarMenuBadge>
                          <PendingCount n={pending} hidden />
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
                {plugins ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setAllPlugins((a) => !a)}
                      aria-expanded={allPlugins}
                      tooltip={allPlugins ? 'Fewer plugin pages' : 'All plugin pages'}
                      className={cn(ROW, 'text-muted-foreground')}
                    >
                      {allPlugins ? (
                        <ChevronUp aria-hidden="true" />
                      ) : (
                        <Ellipsis aria-hidden="true" />
                      )}
                      <span>{allPlugins ? 'Fewer' : `${items.length - shown.length} more`}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      {/* Who is signed in, their account, the shortcuts, the theme, and signing in or out. */}
      <SidebarFooter className="border-sidebar-border border-t pb-safe-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <SidebarMenuButton asChild tooltip={shortWho(me, auth)} className={ROW}>
                <DropdownMenuTrigger
                  aria-label={`${shortWho(me, auth)}, account menu`}
                  title={expanded ? who(me, auth) : undefined}
                >
                  <UserRound className="text-muted-foreground" aria-hidden="true" />
                  <ChevronsUpDown
                    className="absolute right-2.5 text-muted-foreground @max-[8rem]:hidden"
                    aria-hidden="true"
                  />
                  <span className="pr-5">{shortWho(me, auth)}</span>
                </DropdownMenuTrigger>
              </SidebarMenuButton>
              <DropdownMenuContent
                side={expanded ? 'top' : 'right'}
                align={expanded ? 'start' : 'end'}
                className="w-56"
              >
                <AccountItems me={me} auth={auth} onShortcuts={onShortcuts} />
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Closes the sidebar opened over the page when a navigation lands. */
function ClosePeekOnNavigation() {
  const { pathname } = useLocation();
  const { setPeek } = useSidebar();
  useEffect(() => setPeek(false), [pathname, setPeek]);
  return null;
}

/** Where a phone starts an order: in thumb reach, on the pages that list orders. */
const NEW_ORDER_FROM = new Set(['/', '/orders']);

/** Pages about deciding and building, where starting an order steps back from ink to an outline. */
const QUIET_NEW_ORDER = [{ to: '/approvals' }, { to: '/flows' }];

function ShellFrame() {
  const slow = useSlowNavigation();
  const { pending, me, nav: showNav, plugins, sidebarOpen } = useLoaderData<typeof loader>();
  const operator = showNav && atLeast(me.role, 'operator');
  // A plugin's pages are served by its own Worker, so its links load a whole document.
  const nav: NavItem[] = showNav
    ? [
        ...NAV,
        ...plugins
          .filter((p) => atLeast(me.role, p.pageRole))
          .flatMap((p) =>
            p.nav.map((n) => ({
              to: n.path,
              label: n.label,
              icon: Blocks,
              document: true,
              plugin: true,
            })),
          ),
      ]
    : [];
  const workspace = showNav && atLeast(me.role, 'admin') ? WORKSPACE : [];
  const groups = [
    { items: nav.filter((n) => !n.section && !n.plugin) },
    { title: 'Build', items: nav.filter((n) => n.section === 'Build') },
    { title: 'Reference', items: nav.filter((n) => n.section === 'Reference') },
    { title: 'From plugins', items: nav.filter((n) => n.plugin) },
    { title: 'Workspace', items: workspace },
  ].filter((g) => g.items.length);
  const path = useCurrentPath();
  const [shortcuts, setShortcuts] = useState(false);
  const openShortcuts = useCallback(() => setShortcuts(true), []);
  useGoKeys(openShortcuts);
  const phoneNewOrder = operator && NEW_ORDER_FROM.has(path);
  // The assistant's sheet covers the page, and this button would sit on its send button.
  const assistantOpen = useAssistant().open;
  const quietNewOrder = QUIET_NEW_ORDER.some((p) => isAt(path, p));
  // The sidebar opens over the page, as a rail beside it, below lg, on a canvas, and beside the
  // assistant's column below xl. Asked as "narrow" so the server (which sees neither) assumes wide.
  const narrow = useMedia('(max-width: 1023.98px)');
  const xl = useMedia('(min-width: 1280px)');
  const overlay = narrow || railFor(path) || (assistantOpen && !xl);
  return (
    <SidebarProvider
      defaultOpen={sidebarOpen}
      overlay={overlay}
      // The rail clears a phone's notch on its side.
      style={{ '--sidebar-width-icon': 'calc(3.25rem + var(--safe-left))' } as React.CSSProperties}
      className="min-h-dvh"
    >
      <ClosePeekOnNavigation />
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {showNav ? (
        <AppSidebar groups={groups} pending={pending} path={path} onShortcuts={openShortcuts} />
      ) : null}
      <SidebarInset>
        {/* 3rem tall with its rule, under the status bar's inset: full-height pages and the
            assistant subtract --shell-h (app.css). From md the sidebar holds the brand, the pages
            and the account, so this holds only what acts on the page. */}
        <header className="vt-shell-bar sticky top-0 z-40 border-b bg-background pt-safe-0">
          <div className="flex h-[calc(3rem-1px)] items-center gap-3 pr-safe-4 pl-safe-4 sm:gap-6 sm:pr-safe-5 sm:pl-safe-5 md:pl-5">
            <Link
              to="/"
              viewTransition
              className={cn(
                'hit-area -mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 font-semibold tracking-title text-base',
                showNav && 'md:hidden',
              )}
              aria-label="OrderLoop overview"
            >
              <Mark className="size-5" />
              <span className="hidden sm:inline">OrderLoop</span>
            </Link>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
              {showNav ? <AssistantToggle /> : null}
              {operator ? (
                <Link
                  to="/orders/new"
                  title="New order"
                  className={cn(
                    'hit-area hidden h-8 items-center justify-center gap-1.5 rounded-4xl px-3 font-medium text-ui md:inline-flex',
                    tint,
                    quietNewOrder
                      ? 'border border-input bg-input/30 text-foreground hover:bg-input/50'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90',
                  )}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  New order
                </Link>
              ) : null}
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
            className={cn(
              'min-w-0 flex-1 pb-[var(--tabbar-h)] outline-none md:pb-0',
              // Room under the last row for the New order button.
              phoneNewOrder && 'pb-[calc(var(--tabbar-h)+4.5rem)]',
            )}
          >
            <Outlet />
          </main>
          {showNav ? <LazyAssistantPanel /> : null}
        </div>
      </SidebarInset>
      {phoneNewOrder && !assistantOpen ? (
        <Link
          to="/orders/new"
          data-float-action
          className="fixed right-[max(1rem,var(--safe-right))] bottom-[calc(var(--tabbar-h)+0.75rem)] z-30 inline-flex h-11 items-center gap-1.5 rounded-4xl bg-primary pr-4.5 pl-4 font-medium text-primary-foreground text-sm shadow-float md:hidden"
        >
          <Plus className="size-4" aria-hidden="true" />
          New order
        </Link>
      ) : null}
      <TabBar nav={nav} workspace={workspace} pending={pending} path={path} />
      {showNav ? <ShortcutsSheet open={shortcuts} onOpenChange={setShortcuts} /> : null}
    </SidebarProvider>
  );
}

/**
 * Phones: the main pages as tabs along the bottom, in thumb reach and clear of the home indicator,
 * and More for everything else. Wider screens have the sidebar instead.
 */
function TabBar({
  nav,
  workspace,
  pending,
  path,
}: {
  nav: NavItem[];
  workspace: NavItem[];
  pending: number;
  path: string;
}) {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  // A link in the sheet closes it by navigating; so does the back button (pathname is the trigger).
  useEffect(() => setMore(false), [pathname]);
  const tabs = nav.length ? TABS : [];
  const inTab = tabs.some((t) => isAt(path, t));
  const item = cn(
    'relative flex flex-col items-center justify-center gap-0.5 text-2xs short:gap-0',
    tint,
  );
  const state = (active: boolean) =>
    active
      ? 'font-medium text-foreground before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:bg-foreground'
      : 'text-muted-foreground';
  return (
    <>
      <nav
        aria-label="Main"
        className="vt-tab-bar fixed inset-x-0 bottom-0 z-40 h-[var(--tabbar-h)] border-t bg-background px-safe-0 pb-[var(--safe-bottom)] md:hidden"
      >
        <ul
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }}
        >
          {tabs.map(({ to, label, icon: Icon, end, badge }) => (
            <li key={to} className="contents">
              <NavLink
                to={to}
                end={end}
                viewTransition
                className={cn(item, state(isAt(path, { to, end })))}
              >
                <span className="relative">
                  <Icon className="size-5" aria-hidden="true" />
                  {badge && pending > 0 ? (
                    <span className="absolute -top-1.5 left-3.5 min-w-4 rounded-full bg-wait px-1 text-center font-medium text-2xs text-background leading-4 tabular">
                      {countLabel(pending)}
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
          <MoreMenu
            nav={nav.filter((n) => !TABS.some((t) => t.to === n.to))}
            workspace={workspace}
            pending={pending}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The More sheet, grouped as the sidebar groups them: the pages without a tab, plugins' pages and
 * the workspace's, then the account, the theme and signing in or out (as in the account menu).
 */
function MoreMenu({
  nav,
  workspace,
  pending,
}: {
  nav: NavItem[];
  workspace: NavItem[];
  pending: number;
}) {
  const { me, auth } = useLoaderData<typeof loader>();
  const theme = useTheme();
  const admin = atLeast(me.role, 'admin');
  const row =
    'flex min-h-11 items-center justify-between gap-3 rounded-md px-3 text-base hover:bg-accent aria-[current=page]:font-medium';
  const heading = 'caption px-3 pt-2 pb-1';
  const list = (items: NavItem[]) => (
    <ul>
      {items.map(({ to, label, end, badge, document }) => (
        <li key={to}>
          <NavLink to={to} end={end} reloadDocument={document} viewTransition className={row}>
            {label}
            {badge && pending > 0 ? <PendingCount n={pending} /> : null}
          </NavLink>
        </li>
      ))}
    </ul>
  );
  const pages = nav.filter((n) => !n.plugin);
  const pluginPages = nav.filter((n) => n.plugin);
  return (
    <>
      <div className="border-b px-4 pt-4 pb-3 pr-14">
        <SheetTitle className="truncate font-semibold text-base tracking-title">
          {who(me, auth)}
        </SheetTitle>
        <SheetDescription className="text-xs">{ROLE_LABELS[me.role]}</SheetDescription>
      </div>
      <div className="p-2">
        <h2 className={heading}>Pages</h2>
        {list(pages)}
        {pluginPages.length ? (
          <>
            <h2 className={cn(heading, 'pt-3')}>From plugins</h2>
            {list(pluginPages)}
          </>
        ) : null}
        {workspace.length ? (
          <>
            <h2 className={cn(heading, 'pt-3')}>Workspace</h2>
            {list(workspace)}
          </>
        ) : null}
      </div>
      <div className="border-t p-2">
        {list([{ to: '/account', label: 'Account', icon: UserRound }])}
      </div>
      <fieldset className="border-t px-4 pt-3 pb-3">
        <legend className="caption float-left mb-2 w-full">Theme</legend>
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
      <DropdownMenuLabel className="caption">Theme</DropdownMenuLabel>
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

/**
 * The same, short enough for the account button. A person is their name; a session without one is
 * how it got in, and with sign-in off, the role everyone acts as.
 */
const shortWho = (me: Principal, auth: boolean) =>
  me.kind === 'user' ? me.name : auth ? 'Workspace' : `${ROLE_LABELS[me.role]}, no sign-in`;

/**
 * Who is signed in, their account, the keyboard shortcuts (with a keyboard), the theme, and
 * signing in or out. The workspace's pages are the sidebar's.
 */
function AccountItems({
  me,
  auth,
  onShortcuts,
}: {
  me: Principal;
  auth: boolean;
  onShortcuts: () => void;
}) {
  const admin = atLeast(me.role, 'admin');
  const theme = useTheme();
  return (
    <>
      <DropdownMenuLabel className="font-normal">
        <span
          className="block truncate font-semibold text-foreground text-sm"
          title={who(me, auth)}
        >
          {who(me, auth)}
        </span>
        <span className="text-muted-foreground text-xs">{ROLE_LABELS[me.role]}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/account">Account</Link>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onShortcuts} className="hidden justify-between fine:flex">
        Keyboard shortcuts
        <kbd className="font-normal font-sans text-2xs text-muted-foreground">?</kbd>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <ThemeItems value={theme.choice} onChange={theme.setChoice} />
      {auth || admin ? <DropdownMenuSeparator /> : null}
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
