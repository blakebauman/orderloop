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
import { useState } from 'react';
import { data, Form, Link, useActionData, useLoaderData, useLocation } from 'react-router';
import { Mark } from '~/components/mark';
import { audit } from '~/lib/audit.server';
import { type GrantProps, requireUser } from '~/lib/auth.server';
import { channelOf, oauthApi } from '~/lib/oauth.server';
import type { Route } from './+types/oauth-authorize';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  {
    title:
      d && 'error' in d
        ? 'Can’t connect this app · OrderLoop'
        : d && 'personal' in d
          ? 'Use your own account · OrderLoop'
          : 'Connect an app · OrderLoop',
  },
];

/**
 * The workspace password belongs to no one, so it can't stand behind a lasting grant: an app's
 * actions must trace to a person. (Open local development has no accounts at all and keeps working.)
 */
const SHARED_REFUSED = 'Sign in with your own account to connect an app.';

/** The consent cookie and anti-framing headers from the loader, and the redirect's cookies. */
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const h = new Headers(loaderHeaders);
  actionHeaders.forEach((v, k) => {
    h.append(k, v);
  });
  return h;
};

/** What an app may be granted. Admin isn't offered: MCP and A2A have no admin tools. */
const ROLE_SCOPE: Partial<Record<Role, string>> = {
  viewer: 'Read orders, flows, approvals and stock',
  approver: 'Also approve or reject approvals',
  operator: 'Also deliver events, cancel orders, publish flows and run the stock review',
};
const grantable = (r: Role) => r in ROLE_SCOPE;

/**
 * A refused request in words a person can act on. The provider's own description stays beside it,
 * small, for whoever builds the app.
 */
function explain(err: AuthorizationError): string {
  const d = err.description.toLowerCase();
  if (d.includes('client'))
    return 'OrderLoop doesn’t recognise the app that sent you here, so it can’t tell who is asking.';
  if (d.includes('redirect'))
    return 'The app’s return address doesn’t match the one it registered, so OrderLoop won’t send it access.';
  if (err.code === 'invalid_target')
    return 'The app asked for access to something OrderLoop doesn’t offer.';
  if (err.code === 'temporarily_unavailable' || err.code === 'server_error')
    return 'OrderLoop couldn’t finish this just now. Try again in a moment.';
  return 'This connection link is incomplete or has expired.';
}

/** What the provider refused, as a page; never a redirect to an unverified client. */
function refusal(err: unknown) {
  if (err instanceof AuthorizationError && err.redirectTo)
    return new Response(null, { status: 302, headers: { location: err.redirectTo } });
  if (err instanceof AuthorizationError)
    return data({ error: explain(err), detail: err.description || err.code }, { status: 400 });
  if (err instanceof CimdFetchError)
    return data(
      {
        error: 'OrderLoop couldn’t check who published this app. Try again later.',
        detail: err.message,
      },
      { status: 400 },
    );
  throw err;
}

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const oauth = oauthApi(request);
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    // First: a failed lookup leaves nothing behind.
    const details = await oauth.describeConsent(authRequest);
    if (me.kind === 'password') return { personal: true as const, app: details.clientName };
    const consent = await oauth.beginConsent(authRequest);
    const roles = ROLES.filter((r) => grantable(r) && atLeast(me.role, r));
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
    if (me.kind === 'password' && form.get('decision') === 'approve')
      return data({ error: SHARED_REFUSED }, { status: 403 });
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const role = form.get('role');
    if (!isRole(role) || !grantable(role) || !atLeast(me.role, role))
      return data({ error: 'Choose a role you have yourself.' }, { status: 400 });
    const approved = await oauth.approveConsent(request, handle, { scope: [role] });
    const client = await oauth.lookupClient(approved.request.clientId);
    const app = client?.clientName || approved.request.clientId;
    const props: GrantProps = { kind: me.kind, id: me.id, role };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: me.id,
      // Shown on the Account page, so two apps with one name can be told apart.
      metadata: {
        app,
        channel: channelOf(approved.request.resource),
        // The host the consent page named (no port), so both pages show the same address.
        host: new URL(approved.request.redirectUri).hostname,
      },
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
  const here = useLocation();
  // Signing out returns here, so the person signs in as themselves and sees this request again.
  const switchAccount = `/logout?next=${encodeURIComponent(here.pathname + here.search)}`;
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-md rounded-md border bg-card p-6">
        <Mark className="size-7" />
        {'personal' in d ? (
          <>
            <h1 className="mt-4 text-balance font-semibold tracking-title text-2xl">
              Use your own account to connect an app
            </h1>
            <p className="mt-2 text-sm">
              You’re signed in with the workspace password, which belongs to no one. An app acts for
              a person, so OrderLoop can’t connect “{d.app}” to it.
            </p>
            <p className="mt-2 text-muted-foreground text-sm">
              Sign in with your own account and this request comes back. No account yet? An admin
              can add you on the Team page.
            </p>
            <Button asChild className="mt-5">
              <a href={switchAccount}>Sign in with your account</a>
            </Button>
          </>
        ) : 'error' in d ? (
          <>
            <h1 className="mt-4 font-semibold tracking-title text-2xl">Can’t connect this app</h1>
            <p className="mt-2 text-sm">{d.error}</p>
            <p className="mt-3 text-muted-foreground text-sm">
              Start again from the app you were connecting.
            </p>
            {d.detail ? (
              <p className="mt-3 font-mono text-muted-foreground text-xs">Details: {d.detail}</p>
            ) : null}
            <Link to="/" className="mt-5 inline-block text-link text-sm hover:underline">
              Go to OrderLoop
            </Link>
          </>
        ) : (
          <Consent {...d} switchAccount={switchAccount} />
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
  switchAccount,
}: {
  details: ConsentDescription;
  handle: string;
  roles: Role[];
  who: string;
  channel: string;
  switchAccount: string;
}) {
  // React escapes every string below; all of them may come from the client.
  const [sending, setSending] = useState<string | null>(null);
  const refused = useActionData<typeof action>();
  const kind = channel === 'A2A' ? 'an agent (A2A)' : 'an AI client (MCP)';
  return (
    <Form
      method="post"
      reloadDocument
      onSubmit={(e) => {
        // One decision per page. The buttons stay enabled: a disabled submitter would drop its
        // `decision` from the form, turning Connect into Cancel.
        if (sending) e.preventDefault();
        else
          setSending((e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? 'approve');
      }}
    >
      <input type="hidden" name="handle" value={handle} />
      {/* The name is the app's own claim; without a known publisher, say so beside it. */}
      <h1 className="mt-4 text-balance font-semibold tracking-title text-2xl">
        Connect {details.clientDomain ? details.clientName : `“${details.clientName}”`} to
        OrderLoop?
      </h1>
      {details.clientDomain ? null : (
        <span className="mt-1.5 inline-block rounded-sm bg-wait/15 px-1.5 py-0.5 font-medium text-wait text-xs">
          Unverified name
        </span>
      )}
      <p className="mt-2 text-sm">
        {details.clientDomain ? (
          <>
            Published by <strong className="font-medium">{details.clientDomain}</strong>.
          </>
        ) : (
          'This app registered itself; its name is not verified.'
        )}{' '}
        It is {kind}. Access will be sent to{' '}
        <strong className="font-mono font-medium">{details.redirectHost}</strong>.
      </p>
      <p className="mt-2 text-muted-foreground text-xs">
        Not {who}?{' '}
        <a href={switchAccount} className="text-link hover:underline">
          Use a different account
        </a>
      </p>
      {details.redirectIsLoopback ? (
        <p className="mt-3 rounded-md border border-wait/40 bg-wait/10 p-3 text-sm">
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
            <label
              key={r}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary"
            >
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
        Orders show what it does as “{who} via {channel}”. It keeps access until you disconnect it
        on your Account page, and never more than your own role: lower your role, and the app’s
        drops with it.
      </p>
      {refused && 'error' in refused ? (
        <p role="alert" className="mt-3 text-destructive text-sm">
          {refused.error}
        </p>
      ) : null}
      <div className="mt-5 flex gap-2">
        <Button
          type="submit"
          name="decision"
          value="approve"
          aria-disabled={!!sending || undefined}
        >
          {sending === 'approve' ? 'Connecting…' : 'Connect'}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="deny"
          variant="outline"
          aria-disabled={!!sending || undefined}
        >
          {sending === 'deny' ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>
    </Form>
  );
}
