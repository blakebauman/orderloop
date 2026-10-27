/**
 * A customer's tax certificate file, downloaded by anyone signed in who may see the customer.
 * Served as an attachment under a CSP that runs nothing, as a cart's files are.
 */

import { requireUser } from '~/lib/auth.server';
import { certificateFile } from '~/lib/customers.server';
import type { Route } from './+types/tax-certificate-file';

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const found = await certificateFile(params.customerId, params.certificateId);
  if (!found) return new Response('Not found', { status: 404 });
  const { file, body } = found;
  return new Response(body, {
    headers: {
      'content-type': file.type,
      'content-length': String(file.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
