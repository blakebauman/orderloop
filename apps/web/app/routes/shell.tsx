import { approvals } from '@orderloop/db';
import { cn } from '@orderloop/ui/lib/utils';
import { eq, sql } from 'drizzle-orm';
import { Plus } from 'lucide-react';
import { Link, NavLink, Outlet, useLoaderData } from 'react-router';
import { Mark } from '~/components/mark';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { db } from '~/lib/env.server';
import type { Route } from './+types/shell';

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const pending = await db()
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .get();
  return { pending: pending?.n ?? 0, auth: authEnabled() };
}

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/orders', label: 'Orders' },
  { to: '/approvals', label: 'Approvals', badge: true },
  { to: '/flows', label: 'Flows' },
  { to: '/back-office', label: 'Back office' },
];

export default function Shell() {
  const { pending, auth } = useLoaderData<typeof loader>();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="flex h-12 items-center gap-6 px-5">
          <Link to="/" className="flex items-center gap-2 font-semibold text-[15px] tracking-tight">
            <Mark className="size-5 text-primary" />
            Order Loop
          </Link>
          <nav className="-mb-px flex h-full items-stretch gap-1 overflow-x-auto">
            {NAV.map(({ to, label, end, badge }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 border-b-2 border-transparent px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
                    isActive && 'border-foreground font-medium text-foreground',
                  )
                }
              >
                {label}
                {badge && pending > 0 ? (
                  <span className="rounded-sm bg-wait/15 px-1 font-mono text-[11px] text-wait tabular">
                    {pending}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Link
              to="/orders/new"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-[13px] text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="size-3.5" /> New order
            </Link>
            {auth ? (
              <a href="/logout" className="text-[13px] text-muted-foreground hover:text-foreground">
                Sign out
              </a>
            ) : null}
          </div>
        </div>
      </header>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
