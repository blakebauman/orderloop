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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@orderloop/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@orderloop/ui/field';
import { useState } from 'react';
import { data, Form, Link, useActionData, useLoaderData, useLocation } from 'react-router';
import { Mark } from '~/components/mark';
import { StepUpField } from '~/components/step-up-field';
import { audit } from '~/lib/audit.server';
import {
  type GrantProps,
  requireUser,
  type StepUpMethod,
  stepUp,
  stepUpMethod,
} from '~/lib/auth.server';
import { channelOf, type GRANTABLE_ROLES, oauthApi } from '~/lib/oauth.server';
import type { Route } from './+types/oauth-authorize';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  {
    title: d && 'error' in d ? 'Can’t connect this app · OrderLoop' : 'Connect an app · OrderLoop',
  },
];

/** The consent cookie and anti-framing headers from the loader, and the redirect's cookies. */
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const h = new Headers(loaderHeaders);
  actionHeaders.forEach((v, k) => {
    h.append(k, v);
  });
  return h;
};

/** What an app may be granted (`GRANTABLE_ROLES`). Admin isn't offered. */
const ROLE_SCOPE: Partial<Record<Role, string>> = {
  viewer: 'Read orders, flows, approvals and stock',
  approver: 'Also approve or reject approvals',
  operator: 'Also deliver events, cancel orders, publish flows and run the stock review',
} satisfies Record<(typeof GRANTABLE_ROLES)[number], string>;
const grantable = (r: Role) => r in ROLE_SCOPE;

/**
 * A refused request in words a person can act on. Only the error's code is shown beside it, for
 * whoever builds the app.
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
  // Only the error's code is shown: the provider's own description can carry what the client sent.
  if (err instanceof AuthorizationError)
    return data({ error: explain(err), detail: err.code }, { status: 400 });
  if (err instanceof CimdFetchError)
    return data(
      {
        error: 'OrderLoop couldn’t check who published this app. Try again later.',
        detail: 'client_metadata_unavailable',
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
    // PKCE for every app (RFC 9700 §2.1.1): the provider asks it only of public clients, but a
    // client that registered with a secret can leak its code just the same.
    if (!authRequest.codeChallenge)
      return data(
        {
          error: 'This app didn’t send a PKCE challenge, so OrderLoop won’t send it access.',
          detail: 'invalid_request',
        },
        { status: 400 },
      );
    // First: a failed lookup leaves nothing behind.
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const roles = ROLES.filter((r) => grantable(r) && atLeast(me.role, r));
    return data(
      {
        details,
        handle: consent.handle,
        roles,
        who: me.email ?? me.name,
        channel: channelOf(authRequest.resource),
        stepUp: await stepUpMethod(me),
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
    if (!isRole(role) || !grantable(role) || !atLeast(me.role, role))
      return data({ error: 'Choose a role you have yourself.' }, { status: 400 });
    // An app that can act, not just read, keeps access for weeks: confirm it's the person at the
    // keyboard first, before the single-use handle is spent.
    if (me.kind === 'user' && role !== 'viewer') {
      const failed = await stepUp(request, me, {
        code: String(form.get('code') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      if (failed) {
        await audit(request, 'auth.step_up_failed', {
          actor: me,
          detail: { intent: 'oauth-consent', role, error: failed },
        });
        return data({ error: failed }, { status: 403 });
      }
    }
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
      <Card className="w-full max-w-md">
        {'error' in d ? (
          <>
            <CardHeader>
              <Mark className="size-7" />
              <CardTitle className="mt-2">
                <h1 className="font-semibold tracking-title text-2xl">Can’t connect this app</h1>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{d.error}</p>
              <p className="text-muted-foreground text-sm">
                Start again from the app you were connecting.
              </p>
              {d.detail ? (
                <p className="font-mono text-muted-foreground text-xs">Details: {d.detail}</p>
              ) : null}
              <Link to="/" className="mt-2 inline-block text-link text-sm hover:underline">
                Go to OrderLoop
              </Link>
            </CardContent>
          </>
        ) : (
          <Consent {...d} switchAccount={switchAccount} here={here.pathname + here.search} />
        )}
      </Card>
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
  stepUp,
  here,
}: {
  details: ConsentDescription;
  handle: string;
  roles: Role[];
  who: string;
  channel: string;
  switchAccount: string;
  stepUp: StepUpMethod | null;
  here: string;
}) {
  // React escapes every string below; all of them may come from the client.
  const [sending, setSending] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Role | undefined>(roles[0]);
  const refused = useActionData<typeof action>();
  const kind = channel === 'A2A' ? 'an agent (A2A)' : 'an AI client (MCP)';
  return (
    <>
      <CardHeader>
        <Mark className="size-7" />
        {/* The name is the app's own claim; without a known publisher, say so beside it. */}
        <CardTitle className="mt-2">
          <h1 className="text-balance font-semibold tracking-title text-2xl">
            Connect {details.clientDomain ? details.clientName : `“${details.clientName}”`} to
            OrderLoop?
          </h1>
        </CardTitle>
        {details.clientDomain ? null : (
          <span className="w-fit rounded-full bg-wait/15 px-1.5 py-0.5 font-medium text-wait text-xs">
            Unverified name
          </span>
        )}
        <CardDescription className="text-foreground">
          {details.clientDomain ? (
            <>
              Published by <strong className="font-medium">{details.clientDomain}</strong>.
            </>
          ) : (
            'This app registered itself; its name is not verified.'
          )}{' '}
          It is {kind}. Access will be sent to{' '}
          <strong className="font-mono font-medium">{details.redirectHost}</strong>.
        </CardDescription>
        <p className="text-muted-foreground text-xs">
          Not {who}?{' '}
          <button type="submit" form="switch-account" className="text-link hover:underline">
            Use a different account
          </button>
        </p>
      </CardHeader>
      <CardContent>
        <Form
          method="post"
          reloadDocument
          onSubmit={(e) => {
            // One decision per page. The buttons stay enabled: a disabled submitter would drop its
            // `decision` from the form, turning Connect into Cancel.
            if (sending) e.preventDefault();
            else
              setSending(
                (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? 'approve',
              );
          }}
        >
          <input type="hidden" name="handle" value={handle} />
          <FieldGroup className="gap-5">
            {details.redirectIsLoopback ? (
              <p className="rounded-lg border border-wait/40 bg-wait/10 p-3 text-sm">
                <span className="font-medium">This sends access to an app on your computer.</span>{' '}
                Continue only if you just started connecting from it.
              </p>
            ) : null}
            <FieldSet className="gap-2">
              <FieldLegend variant="label" className="mb-1 font-normal">
                It will act as <span className="font-medium">{who}</span>, with the role
              </FieldLegend>
              {roles.map((r, i) => (
                <FieldLabel
                  key={r}
                  className="cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-secondary"
                >
                  <Field orientation="horizontal" className="items-start gap-2.5 p-3!">
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      defaultChecked={i === 0}
                      onChange={() => setChosen(r)}
                      className="mt-0.5"
                    />
                    <FieldContent>
                      <FieldTitle>{ROLE_LABELS[r]}</FieldTitle>
                      <FieldDescription className="text-xs">{ROLE_SCOPE[r]}</FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              ))}
              <FieldDescription className="mt-1 text-xs">
                Orders show what it does as “{who} via {channel}”. It keeps access until you
                disconnect it on your Account page, and never more than your own role: lower your
                role, and the app’s drops with it.
              </FieldDescription>
            </FieldSet>
            {chosen && chosen !== 'viewer' ? <StepUpField method={stepUp} next={here} /> : null}
            {refused && 'error' in refused ? <FieldError>{refused.error}</FieldError> : null}
            <div className="flex gap-2">
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
          </FieldGroup>
        </Form>
        {/* Signing out is a POST; it comes back here (`next`) to sign in as someone else. */}
        <form id="switch-account" method="post" action={switchAccount} hidden />
      </CardContent>
    </>
  );
}
