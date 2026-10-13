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
import { Menu, Monitor, Moon, Plus, Sun } from 'lucide-react';
import { Link, NavLink, Outlet, useLoaderData } from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { db } from '~/lib/env.server';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const pending = await db()
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .get();
  return { pending: pending?.n ?? 0, auth: await authEnabled(), me };
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
  const { pending, auth, me } = useLoaderData<typeof loader>();
  const operator = atLeast(me.role, 'operator');
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
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="flex h-12 items-center gap-3 px-4 sm:gap-6 sm:px-5">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 font-semibold font-serif text-[16px]"
            aria-label="Order Loop overview"
          >
            <Mark className="size-5" />
            <span className="hidden sm:inline">Order Loop</span>
          </Link>
          <nav aria-label="Main" className="-mb-px hidden h-full items-stretch gap-1 md:flex">
            {NAV.map(({ to, label, end, badge }) => (
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
                aria-label={`Theme: ${theme.choice}`}
              >
                <ThemeIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <ThemeItems value={theme.choice} onChange={theme.setChoice} />
                {auth ? (
                  <AccountItems me={me} />
                ) : (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/team">Set up sign-in</Link>
                    </DropdownMenuItem>
                  </>
                )}
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
                {NAV.map(({ to, label, badge }) => (
                  <DropdownMenuItem key={to} asChild>
                    <Link to={to} className="justify-between">
                      {label}
                      {badge && pending > 0 ? <PendingCount n={pending} /> : null}
                    </Link>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <ThemeItems value={theme.choice} onChange={theme.setChoice} />
                {auth ? (
                  <AccountItems me={me} />
                ) : (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/team">Set up sign-in</Link>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main id="main" className="min-w-0 flex-1">
        <Outlet />
      </main>
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

/** Who is signed in, and where they manage their sign-in or the team. */
function AccountItems({ me }: { me: Principal }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="font-normal">
        <span className="block truncate font-medium text-sm">{me.email ?? me.name}</span>
        <span className="text-muted-foreground text-xs">{ROLE_LABELS[me.role]}</span>
      </DropdownMenuLabel>
      {me.kind === 'user' ? (
        <DropdownMenuItem asChild>
          <Link to="/account">Account</Link>
        </DropdownMenuItem>
      ) : null}
      {atLeast(me.role, 'operator') ? (
        <DropdownMenuItem asChild>
          <Link to="/team">Team</Link>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem asChild>
        <a href="/logout">Sign out</a>
      </DropdownMenuItem>
    </>
  );
}
