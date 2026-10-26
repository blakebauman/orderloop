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
  ChevronDown,
  Ellipsis,
  LayoutDashboard,
  MessageSquareText,
  Monitor,
  Moon,
  Plus,
  ReceiptText,
  ShoppingCart,
  Stamp,
  Sun,
  UserRound,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { useShortcutLabel } from '~/lib/device';
import { db } from '~/lib/env.server';
import { PluginsProvider } from '~/lib/plugins';
import { pluginManifests } from '~/lib/plugins.server';
import { pageShortcut } from '~/lib/shortcuts';
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

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  badge?: boolean;
  document?: boolean;
  /** Starts a group in the top bar, after a hairline. */
  group?: boolean;
  /** A reference page: in the top bar's More menu rather than a link of its own. */
  more?: boolean;
  /** A plugin's page, under its own heading in More. */
  plugin?: boolean;
};

/**
 * In this order everywhere: the day's work, then building, then reference pages (and plugins'),
 * which the top bar keeps under More.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/orders', label: 'Orders' },
  { to: '/approvals', label: 'Approvals', badge: true },
  { to: '/carts', label: 'Carts' },
  { to: '/flows', label: 'Flows', group: true },
  { to: '/commerce', label: 'Commerce', more: true },
  { to: '/performance', label: 'Performance', more: true },
];

/**
 * Phones are for keeping up and deciding: the day's work as tabs, in NAV's order. Flows (which a
 * phone only reviews) and the rest are under More.
 */
const TABS: { to: string; label: string; icon: typeof Sun; end?: boolean; badge?: boolean }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/orders', label: 'Orders', icon: ReceiptText },
  { to: '/approvals', label: 'Approvals', icon: Stamp, badge: true },
  { to: '/carts', label: 'Carts', icon: ShoppingCart },
];

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
];

/** Past two digits a count is 99+, everywhere it's shown. */
const countLabel = (n: number) => (n > 99 ? '99+' : String(n));

/** The workspace's own pages, for admins: under More beside the reference pages. */
const WORKSPACE: NavItem[] = [
  { to: '/team', label: 'Team and roles' },
  { to: '/audit', label: 'Audit log' },
  { to: '/plugins', label: 'Plugins' },
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
          <kbd className="min-w-6 rounded-md border px-1.5 py-0.5 text-center font-sans text-foreground text-xs">
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
  const save = useShortcutLabel('S');
  const send = useShortcutLabel('Enter');
  const row = 'flex items-center justify-between gap-4 py-1.5 text-sm';
  const group = (title: string, rows: [string, string[], string?][]) => (
    <section className="px-4 pt-3 pb-2">
      <h3 className="caption mb-1 font-medium">{title}</h3>
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
          <SheetTitle className="text-base">Keyboard shortcuts</SheetTitle>
          <SheetDescription className="text-xs">
            Single keys work outside fields, with no menu open.
          </SheetDescription>
        </div>
        {group('Everywhere', [
          ['Open or close the assistant', [assistant]],
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
        <ShellFrame />
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
          : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <MessageSquareText className="size-3.5" aria-hidden="true" />
      <span className="sr-only sm:not-sr-only md:max-lg:sr-only [[data-squeeze~=assistant]_&]:sr-only">
        Assistant
      </span>
      <span
        aria-hidden="true"
        className="hidden font-sans text-2xs text-muted-foreground xl:fine:inline [[data-squeeze~=assistant]_&]:hidden"
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

/** What gives way, in this order, before any link folds into More. */
const SQUEEZE = ['wordmark', 'account', 'assistant', 'new'];

/**
 * Fits the top bar to its width as the window and the reader's text size change. Labels give way
 * first (the wordmark, the account's name, then Assistant's and New order's words, which stay as
 * named icons), and only then do links fold into More from the right; the links' room never gets
 * narrower than More. An invisible ruler holds every link, and each way More can read, at natural
 * width. It runs before paint and marks what gave way on the bar (`data-squeeze`), so a label that
 * doesn't fit never draws.
 *
 * `current` is the current page's index among the links, the link count when it's one of More's
 * own pages, or -1; `badge` is the approvals link's index while approvals wait, else -1.
 */
function useFittingBar(count: number, current: number, badge: number) {
  const bar = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(count);
  useLayoutEffect(() => {
    const row = bar.current;
    const room = box.current;
    const marks = ruler.current;
    if (!row || !room || !marks) return;
    const fit = () => {
      // Phones have the tab bar instead, and nothing to squeeze for.
      if (getComputedStyle(room).display === 'none') {
        row.dataset.squeeze = '';
        return;
      }
      const items = [...marks.children] as HTMLElement[];
      // The last four are More as it can read: More or the current page, with or without the count.
      const mores = items.splice(count);
      const gap = Number.parseFloat(getComputedStyle(marks).columnGap) || 0;
      const more = (n: number) =>
        mores[(current >= n ? 2 : 0) + (badge >= n ? 1 : 0)]?.offsetWidth ?? 0;
      const fitting = () => {
        for (let n = count; n > 0; n--) {
          const last = items[n - 1];
          if (last && last.offsetLeft + last.offsetWidth + gap + more(n) <= room.clientWidth)
            return n;
        }
        return 0;
      };
      let level = 0;
      let n = count;
      for (;;) {
        row.dataset.squeeze = SQUEEZE.slice(0, level).join(' ');
        n = fitting();
        if (n === count || level === SQUEEZE.length) break;
        level++;
      }
      room.style.minWidth = `${more(n)}px`;
      setFits(n);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(room);
    observer.observe(marks);
    return () => observer.disconnect();
  }, [count, current, badge]);
  return { bar, box, ruler, fits: Math.min(fits, count) };
}

/** A top-bar link's underline tab; its outline sits inside it, clear of the rule below. */
const navTab = (active: boolean) =>
  cn(
    'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-ui focus-visible:outline-offset-[-2px]',
    tint,
    active
      ? 'border-foreground font-medium text-foreground'
      : 'border-transparent text-muted-foreground hover:border-rule hover:text-foreground',
  );

/** A link's place in the top bar, with the hairline that starts its group. */
function NavSlot({ group, children }: { group?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0">
      {group ? <span className="mx-1.5 h-4 w-px self-center bg-rule" aria-hidden="true" /> : null}
      {children}
    </div>
  );
}

/**
 * The top bar's More: links that didn't fit the row, the reference pages, plugins' pages and, for
 * admins, the workspace's. While you're on one of them it reads as that page, underlined; it carries
 * the approvals count while Approvals is inside it.
 */
function NavMore({
  overflow,
  reference,
  plugins,
  workspace,
  path,
  pending,
}: {
  overflow: NavItem[];
  reference: NavItem[];
  plugins: NavItem[];
  workspace: NavItem[];
  path: string;
  pending: number;
}) {
  const current = [...overflow, ...reference, ...plugins, ...workspace].find((i) => isAt(path, i));
  const waiting = pending > 0 ? overflow.find((i) => i.badge) : undefined;
  const item = ({ to, label, end, badge, document }: NavItem) => (
    <DropdownMenuItem key={to} asChild>
      <Link
        to={to}
        reloadDocument={document}
        aria-current={isAt(path, { to, end }) ? 'page' : undefined}
        className="justify-between aria-[current=page]:font-medium"
      >
        {label}
        {badge && pending > 0 ? <PendingCount n={pending} /> : null}
      </Link>
    </DropdownMenuItem>
  );
  const section = (title: string, items: NavItem[]) =>
    items.length ? (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="caption font-medium">{title}</DropdownMenuLabel>
        {items.map(item)}
      </>
    ) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(navTab(!!current), 'data-[state=open]:text-foreground')}>
        {current?.label ?? 'More'}
        <span className="sr-only">
          {current ? ', and more pages' : ' pages'}
          {waiting ? `, includes ${waiting.label}, ${pending} pending` : ''}
        </span>
        {waiting ? <PendingCount n={pending} hidden /> : null}
        <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[calc(var(--vvh,100dvh)-var(--shell-h)-1rem)] w-56 overflow-y-auto"
      >
        {overflow.map(item)}
        {overflow.length && reference.length ? <DropdownMenuSeparator /> : null}
        {reference.map(item)}
        {section('From plugins', plugins)}
        {section('Workspace', workspace)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Where a phone starts an order: in thumb reach, on the pages that list orders. */
const NEW_ORDER_FROM = new Set(['/', '/orders']);

/** Pages about deciding and building, where starting an order steps back from ink to an outline. */
const QUIET_NEW_ORDER = [{ to: '/approvals' }, { to: '/flows' }];

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
          .flatMap((p) =>
            p.nav.map((n) => ({ to: n.path, label: n.label, document: true, plugin: true })),
          ),
      ]
    : [];
  const links = nav.filter((n) => !n.more && !n.plugin);
  const reference = nav.filter((n) => n.more);
  const pluginLinks = nav.filter((n) => n.plugin);
  const workspace = showNav && atLeast(me.role, 'admin') ? WORKSPACE : [];
  const path = useCurrentPath();
  const here = links.findIndex((l) => isAt(path, l));
  const inMore = [...reference, ...pluginLinks, ...workspace].find((i) => isAt(path, i));
  const currentLabel = links[here]?.label ?? inMore?.label;
  const { bar, box, ruler, fits } = useFittingBar(
    links.length,
    here >= 0 ? here : inMore ? links.length : -1,
    pending > 0 ? links.findIndex((l) => l.badge) : -1,
  );
  const [shortcuts, setShortcuts] = useState(false);
  const openShortcuts = useCallback(() => setShortcuts(true), []);
  useGoKeys(openShortcuts);
  const phoneNewOrder = operator && NEW_ORDER_FROM.has(path);
  const quietNewOrder = QUIET_NEW_ORDER.some((p) => isAt(path, p));
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
        <div
          ref={bar}
          className="flex h-[calc(3rem-1px)] items-center gap-3 px-safe-4 sm:gap-6 sm:px-safe-5"
        >
          <Link
            to="/"
            className="hit-area -mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 font-semibold tracking-title text-base"
            aria-label="OrderLoop overview"
          >
            <Mark className="size-5" />
            <span className="hidden sm:inline md:max-lg:hidden [[data-squeeze~=wordmark]_&]:hidden">
              OrderLoop
            </span>
          </Link>
          {showNav ? (
            <nav
              ref={box}
              aria-label="Main"
              className="relative -mb-px hidden h-full min-w-0 flex-1 items-stretch gap-1 overflow-hidden md:flex"
            >
              <div
                ref={ruler}
                aria-hidden="true"
                className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max gap-1 overflow-hidden"
              >
                {links.map(({ to, label, badge, group }) => (
                  <NavSlot key={to} group={group}>
                    <span className={navTab(true)}>
                      {label}
                      {badge && pending > 0 ? <PendingCount n={pending} /> : null}
                    </span>
                  </NavSlot>
                ))}
                {[false, true].flatMap((named) =>
                  [false, true].map((counted) => (
                    <span key={`${named}${counted}`} className={navTab(true)}>
                      {named && currentLabel ? currentLabel : 'More'}
                      {counted && pending > 0 ? <PendingCount n={pending} hidden /> : null}
                      <ChevronDown className="size-3.5" />
                    </span>
                  )),
                )}
              </div>
              {links.slice(0, fits).map(({ to, label, end, badge, group }) => (
                <NavSlot key={to} group={group}>
                  <NavLink to={to} end={end} className={navTab(isAt(path, { to, end }))}>
                    {label}
                    {badge && pending > 0 ? <PendingCount n={pending} /> : null}
                  </NavLink>
                </NavSlot>
              ))}
              <NavMore
                overflow={links.slice(fits)}
                reference={reference}
                plugins={pluginLinks}
                workspace={workspace}
                path={path}
                pending={pending}
              />
            </nav>
          ) : null}
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
                    ? 'border border-input text-foreground hover:bg-accent'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span className="max-lg:sr-only [[data-squeeze~=new]_&]:sr-only">New order</span>
              </Link>
            ) : null}
            {/* Who is signed in, the pages that belong to them and the team, and the theme. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${shortWho(me, auth)}, account menu`}
                title={who(me, auth)}
                className={cn(
                  'hit-area hidden h-8 items-center gap-2 rounded-4xl border px-3 text-ui text-muted-foreground hover:bg-accent hover:text-foreground md:flex data-[state=open]:bg-accent data-[state=open]:text-foreground',
                  tint,
                )}
              >
                <UserRound className="size-4" aria-hidden="true" />
                <span className="max-w-32 truncate md:max-lg:sr-only [[data-squeeze~=account]_&]:sr-only">
                  {shortWho(me, auth)}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <AccountItems me={me} auth={auth} onShortcuts={openShortcuts} />
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
      {phoneNewOrder ? (
        <Link
          to="/orders/new"
          className="fixed right-[max(1rem,var(--safe-right))] bottom-[calc(var(--tabbar-h)+0.75rem)] z-30 inline-flex h-11 items-center gap-1.5 rounded-4xl bg-primary pr-4.5 pl-4 font-medium text-primary-foreground text-sm shadow-float md:hidden"
        >
          <Plus className="size-4" aria-hidden="true" />
          New order
        </Link>
      ) : null}
      <TabBar nav={nav} workspace={workspace} pending={pending} path={path} />
      {showNav ? <ShortcutsSheet open={shortcuts} onOpenChange={setShortcuts} /> : null}
    </div>
  );
}

/**
 * Phones: the main pages as tabs along the bottom, in thumb reach and clear of the home indicator,
 * and More for everything else. Wider screens have the links in the top bar instead.
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
        className="fixed inset-x-0 bottom-0 z-40 h-[var(--tabbar-h)] border-t bg-background px-safe-0 pb-[var(--safe-bottom)] md:hidden"
      >
        <ul
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }}
        >
          {tabs.map(({ to, label, icon: Icon, end, badge }) => (
            <li key={to} className="contents">
              <NavLink to={to} end={end} className={cn(item, state(isAt(path, { to, end })))}>
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
 * The More sheet, grouped as the desktop groups them: the pages without a tab, plugins' pages and
 * the workspace's (as in the top bar's More), then the account, the theme and signing in or out
 * (as in the account menu).
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
  const heading = 'caption px-3 pt-2 pb-1 font-medium';
  const list = (items: NavItem[]) => (
    <ul>
      {items.map(({ to, label, end, badge, document }) => (
        <li key={to}>
          <NavLink to={to} end={end} reloadDocument={document} className={row}>
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
        <SheetTitle className="truncate text-base">{who(me, auth)}</SheetTitle>
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
      <div className="border-t p-2">{list([{ to: '/account', label: 'Account' }])}</div>
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

/**
 * The same, short enough for the account button. A person is their name; a session without one is
 * how it got in, and with sign-in off, the role everyone acts as.
 */
const shortWho = (me: Principal, auth: boolean) =>
  me.kind === 'user' ? me.name : auth ? 'Workspace' : `${ROLE_LABELS[me.role]}, no sign-in`;

/**
 * Who is signed in, their account, the keyboard shortcuts (with a keyboard), the theme, and
 * signing in or out. The workspace's pages are in More.
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
        <span className="block truncate font-medium text-foreground text-sm" title={who(me, auth)}>
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
        <kbd className="font-sans text-2xs text-muted-foreground">?</kbd>
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
