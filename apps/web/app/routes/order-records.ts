import { requireUser } from '~/lib/auth.server';
import { orderRecords } from '~/lib/orders.server';
import type { Route } from './+types/order-records';

/**
 * An order's D1 records (payments, shipments, documents, sellers, messages), which the order page
 * fetches again as its run moves. Only these: the live state comes over the page's socket.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  return orderRecords(params.orderId);
}
