import { ShoppingCart, TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Empty } from '~/components/page';

/**
 * The error boundary of the pages an external cart's buyer sees: the reason a loader refused
 * (`cartRefusal`), with no way into the app around it, since the buyer has no sign-in here.
 */
export function CartRefusal() {
  const error = useRouteError();
  const said = isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <Empty
        icon={said ? <ShoppingCart aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        title={
          <h1 className="text-xl tracking-title">
            {said ? 'This cart isn’t available' : 'Something went wrong'}
          </h1>
        }
      >
        {said ?? 'Go back to your purchasing system and open the catalog again.'}
      </Empty>
    </main>
  );
}
