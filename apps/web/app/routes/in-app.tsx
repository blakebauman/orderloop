/**
 * The pages inside the app shell. Its error boundary keeps a refused or missing page inside the
 * shell (header, menus, assistant), so someone turned away still knows where they are.
 */

import { ROLE_LABELS, type Role } from '@orderloop/core';
import { isRouteErrorResponse, Link, Outlet, useRouteLoaderData } from 'react-router';
import { useMe } from '~/lib/use-me';
import type { Route } from './+types/in-app';

export default function InApp() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const me = useMe();
  const shell = useRouteLoaderData('routes/shell') as
    | { operators?: { name: string; email: string }[] }
    | undefined;
  const operators = shell?.operators ?? [];
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const body =
    isRouteErrorResponse(error) && error.data && typeof error.data === 'object' ? error.data : null;
  const need = body && typeof body.need === 'string' ? (body.need as Role) : null;
  const said = body && typeof body.error === 'string' ? (body.error as string) : null;

  if (status === 403 && need && me) {
    return (
      <Refused title="Not with your role">
        <p className="mt-2 text-muted-foreground">
          This page needs the {ROLE_LABELS[need]} role. You’re {article(ROLE_LABELS[me.role])}{' '}
          {ROLE_LABELS[me.role]}.
        </p>
        <p className="mt-2 text-muted-foreground text-sm">
          {operators.length ? (
            <>
              An operator can change your role:{' '}
              {operators.map((o, i) => (
                <span key={o.email}>
                  {i ? ', ' : ''}
                  <a href={`mailto:${o.email}`} className="text-link hover:underline">
                    {o.name}
                  </a>
                </span>
              ))}
              .
            </>
          ) : (
            'An operator can change your role.'
          )}
        </p>
      </Refused>
    );
  }
  if (status === 404) {
    return (
      <Refused title="Not found">
        <p className="mt-2 text-muted-foreground">
          {said ?? 'That page does not exist, or what it showed has been removed.'}
        </p>
      </Refused>
    );
  }
  return (
    <Refused title="Something went wrong">
      <p className="mt-2 text-muted-foreground">
        {said ?? 'This page couldn’t load. Try again, or go back to the overview.'}
      </p>
    </Refused>
  );
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

function Refused({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1400px] px-4 pt-7 pb-10 sm:px-6">
      <title>{`${title} · OrderLoop`}</title>
      <h1 className="font-semibold tracking-title text-[1.75rem] leading-tight">{title}</h1>
      <div className="max-w-[68ch]">{children}</div>
      <Link to="/" className="mt-6 inline-block font-medium text-link text-sm hover:underline">
        Back to the overview
      </Link>
    </div>
  );
}
