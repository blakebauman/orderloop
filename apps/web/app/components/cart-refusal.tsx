import { isRouteErrorResponse, useRouteError } from 'react-router';

/**
 * The error boundary of the pages an external cart's buyer sees: the reason a loader refused
 * (`cartRefusal`), with no way into the app around it, since the buyer has no sign-in here.
 */
export function CartRefusal() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="tracking-title font-semibold text-3xl">
        {said ? 'This cart isn’t available' : 'Something went wrong'}
      </h1>
      <p className="mt-2 text-muted-foreground">
        {said ?? 'Go back to your purchasing system and open the catalog again.'}
      </p>
    </main>
  );
}
