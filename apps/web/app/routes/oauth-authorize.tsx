/**
 * The consent page for MCP and A2A clients (see lib/oauth.server.ts). The person signs in as usual
 * (two-factor included), sees which app is asking and where its access will be sent, and grants
 * it a role no higher than their own. The provider's consent helpers bind the form to this
 * browser, make it single-use and forbid framing.
 */

import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { atLeast, isRole, ROLE_LABELS, ROLES, type Role } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { data, Form, useLoaderData } from 'react-router';
import { Mark } from '~/components/mark';
import { audit } from '~/lib/audit.server';
import { type GrantProps, requireUser } from '~/lib/auth.server';
import { channelOf, oauthApi } from '~/lib/oauth.server';
import type { Route } from './+types/oauth-authorize';

export const meta = () => [{ title: 'Connect an app · OrderLoop' }];

/** The consent cookie and anti-framing headers from the loader, and the redirect's cookies. */
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const h = new Headers(loaderHeaders);
  actionHeaders.forEach((v, k) => {
    h.append(k, v);
  });
  return h;
};

const ROLE_SCOPE: Record<Role, string> = {
  viewer: 'Read orders, flows, approvals and stock',
  approver: 'Also approve or reject approvals',
  operator: 'Also deliver events, cancel orders, publish flows and run the stock review',
};

/** What the provider refused, as a page; never a redirect to an unverified client. */
function refusal(err: unknown) {
  if (err instanceof AuthorizationError && err.redirectTo)
    return new Response(null, { status: 302, headers: { location: err.redirectTo } });
  if (err instanceof AuthorizationError)
    return data(
      { error: err.description || 'This sign-in request is not valid.' },
      { status: 400 },
    );
  if (err instanceof CimdFetchError)
    return data({ error: 'This app could not be verified. Try again later.' }, { status: 400 });
  throw err;
}

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const oauth = oauthApi(request);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    // First: a failed lookup leaves nothing behind.
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const roles = ROLES.filter((r) => atLeast(me.role, r));
    return data(
      {
        details,
        handle: consent.handle,
        roles,
        who: me.email ?? me.name,
        channel: channelOf(authRequest.resource),
      },
      {
        headers: consent.headers,
      },
    );
  } catch (err) {
    return refusal(err);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request);
  const oauth = oauthApi(request);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const role = form.get('role');
    if (!isRole(role) || !atLeast(me.role, role))
      return data({ error: 'Choose a role you have yourself.' }, { status: 400 });
    const approved = await oauth.approveConsent(request, handle, { scope: [role] });
    const client = await oauth.lookupClient(approved.request.clientId);
    const app = client?.clientName || approved.request.clientId;
    const props: GrantProps = { kind: me.kind, id: me.id, role };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: me.id,
      metadata: { app },
      scope: [role],
      props,
    });
    await audit(request, 'oauth.app_connected', {
      actor: me,
      target: app,
      detail: { role, clientId: approved.request.clientId },
    });
    approved.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    return refusal(err);
  }
}

export default function OAuthAuthorize() {
  const d = useLoaderData<typeof loader>();
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-md rounded-md border bg-card p-6">
        <Mark className="size-7" />
        {'error' in d ? (
          <>
            <h1 className="mt-4 font-semibold tracking-title text-2xl">Can’t connect this app</h1>
            <p role="alert" className="mt-2 text-destructive text-sm">
              {d.error}
            </p>
            <p className="mt-3 text-muted-foreground text-sm">
              Start again from the app you were connecting.
            </p>
          </>
        ) : (
          <Consent {...d} />
        )}
      </div>
    </main>
  );
}

function Consent({
  details,
  handle,
  roles,
  who,
  channel,
}: {
  details: ConsentDescription;
  handle: string;
  roles: Role[];
  who: string;
  channel: string;
}) {
  // React escapes every string below; all of them may come from the client.
  return (
    <Form method="post" reloadDocument>
      <input type="hidden" name="handle" value={handle} />
      <h1 className="mt-4 font-semibold tracking-title text-2xl">
        Connect {details.clientName} to OrderLoop?
      </h1>
      <p className="mt-2 text-sm">
        {details.clientDomain ? (
          <>
            Published by <strong className="font-medium">{details.clientDomain}</strong>.
          </>
        ) : (
          'This app registered itself; its name is not verified.'
        )}{' '}
        Access will be sent to{' '}
        <strong className="font-mono font-medium">{details.redirectHost}</strong>.
      </p>
      {details.redirectIsLoopback ? (
        <p role="alert" className="mt-3 rounded-md border border-wait/40 bg-wait/10 p-3 text-sm">
          <span className="font-medium">This sends access to an app on your computer.</span>{' '}
          Continue only if you just started connecting from it.
        </p>
      ) : null}
      <fieldset className="mt-5">
        <legend className="text-sm">
          It will act as <span className="font-medium">{who}</span>, with the role
        </legend>
        <div className="mt-2 space-y-2">
          {roles.map((r, i) => (
            <label key={r} className="flex items-start gap-2.5 rounded-md border p-3 text-sm">
              <input
                type="radio"
                name="role"
                value={r}
                defaultChecked={i === 0}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{ROLE_LABELS[r]}</span>
                <span className="block text-muted-foreground text-xs">{ROLE_SCOPE[r]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-muted-foreground text-xs">
        Orders show what it does as “{who} via {channel}”. Disconnect it any time from your Account
        page.
      </p>
      <div className="mt-5 flex gap-2">
        <Button type="submit" name="decision" value="approve">
          Connect
        </Button>
        <Button type="submit" name="decision" value="deny" variant="outline">
          Cancel
        </Button>
      </div>
    </Form>
  );
}
