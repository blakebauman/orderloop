/**
 * The pages inside the app shell. Its error boundary keeps a refused or missing page inside the
 * shell (header, menus, assistant), so someone turned away still knows where they are.
 */

import { ROLE_LABELS, type Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@orderloop/ui/empty';
import { FileQuestion, ShieldX, TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, Link, Outlet, useRouteLoaderData } from 'react-router';
import { useMe } from '~/lib/use-me';
import type { Route } from './+types/in-app';

export default function InApp() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const me = useMe();
  const shell = useRouteLoaderData('routes/shell') as
    | { admins?: { name: string; email: string }[] }
    | undefined;
  const admins = shell?.admins ?? [];
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const body =
    isRouteErrorResponse(error) && error.data && typeof error.data === 'object' ? error.data : null;
  const need = body && typeof body.need === 'string' ? (body.need as Role) : null;
  const said = body && typeof body.error === 'string' ? (body.error as string) : null;

  if (status === 403 && need && me) {
    return (
      <Refused title="Not with your role" icon={<ShieldX aria-hidden="true" />}>
        <p>
          This page needs the {ROLE_LABELS[need]} role. You’re {article(ROLE_LABELS[me.role])}{' '}
          {ROLE_LABELS[me.role]}.
        </p>
        <p className="mt-2">
          {admins.length ? (
            <>
              An admin can change your role:{' '}
              {admins.map((o, i) => (
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
            'An admin can change your role.'
          )}
        </p>
      </Refused>
    );
  }
  if (status === 404) {
    return (
      <Refused title="Not found" icon={<FileQuestion aria-hidden="true" />}>
        <p>{said ?? 'That page does not exist, or what it showed has been removed.'}</p>
      </Refused>
    );
  }
  return (
    <Refused title="Something went wrong" icon={<TriangleAlert aria-hidden="true" />}>
      <p>{said ?? 'This page couldn’t load. Try again, or go back to the overview.'}</p>
    </Refused>
  );
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

function Refused({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-page px-4 pt-7 pb-10 sm:px-6">
      <title>{`${title} · OrderLoop`}</title>
      <Empty className="gap-5 pt-[10vh]">
        <EmptyHeader className="max-w-measure">
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>
            <h1 className="font-semibold tracking-title text-[1.75rem] leading-tight">{title}</h1>
          </EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/">Back to the overview</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
