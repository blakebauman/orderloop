import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { X } from 'lucide-react';
import { Form, Link, useLoaderData, useSubmit } from 'react-router';
import { Ago } from '~/components/ago';
import { Empty, PageHeader, Section } from '~/components/page';
import {
  AUDIT_GROUPS,
  type AuditEvent,
  actorLabel,
  describeParts,
  isAuditGroup,
  targetHref,
} from '~/lib/audit';
import { listAudit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { orderRef } from '~/lib/format';
import type { Route } from './+types/audit';

export const meta = () => [{ title: 'Audit log · OrderLoop' }];

const PAGE = 100;

/** Actions that record something refused or failed, drawn as a failure. */
const REFUSED = /(_failed|_throttled|_refused|_expired|\.refused)$/;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request, 'admin');
  const q = new URL(request.url).searchParams;
  const type = q.get('type');
  const group = isAuditGroup(type) ? type : undefined;
  const before = Number(q.get('before')) || undefined;
  const events = await listAudit({ group, before, limit: PAGE });
  return { events, group: group ?? '', before: before ?? null, more: events.length === PAGE };
}

export default function Audit() {
  const { events, group, before, more } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const older = events.at(-1)?.at;
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Sign-ins, team and token changes, and what was done to orders, flows and webhooks, newest first. Kept 400 days unless your contract sets another period."
        crumbs={<Link to="/team">Team</Link>}
      />
      <div className="mx-auto max-w-page space-y-4 px-4 pb-10 sm:px-6">
        <Form method="get" className="flex items-center gap-2">
          <label htmlFor="type" className="text-muted-foreground text-sm">
            Show
          </label>
          <NativeSelect
            id="type"
            name="type"
            defaultValue={group}
            className="h-8"
            onChange={(e) => submit(e.currentTarget.form)}
          >
            <NativeSelectOption value="">Everything</NativeSelectOption>
            {Object.entries(AUDIT_GROUPS).map(([k, label]) => (
              <NativeSelectOption key={k} value={k}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {before ? (
            <Link
              to={group ? `/audit?type=${group}` : '/audit'}
              className="text-link text-sm hover:underline"
            >
              Newest
            </Link>
          ) : null}
        </Form>
        <Section title="Events" flush>
          {events.length ? (
            <Table stack="cards" sticky caption="Events">
              <TableHead>
                <Tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>What</Th>
                  <Th>From</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {events.map((e) => (
                  <Tr key={e.id}>
                    <Td className="whitespace-nowrap text-muted-foreground text-xs">
                      <Ago ms={e.at} />
                    </Td>
                    <Td label="Who">
                      {actorLabel(e) ?? <span className="text-muted-foreground">—</span>}
                    </Td>
                    <Td label="What">
                      {/* Something refused or failed: a sign-in, a step-up, an API call. */}
                      {REFUSED.test(e.action) ? (
                        <span className="inline-flex items-baseline gap-1.5 text-bad">
                          <X
                            aria-hidden="true"
                            className="size-3 shrink-0 self-center"
                            strokeWidth={2.5}
                          />
                          <What e={e} />
                        </span>
                      ) : (
                        <What e={e} />
                      )}
                    </Td>
                    <Td label="From" className="font-mono text-muted-foreground text-xs">
                      {e.ip}
                    </Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              {group
                ? 'Nothing of this kind yet.'
                : 'Sign-ins, changes to people and tokens, and refused API calls appear here as they happen, newest first.'}
            </Empty>
          )}
        </Section>
        {more && older ? (
          <Link
            to={`/audit?${new URLSearchParams({ ...(group ? { type: group } : {}), before: String(older) })}`}
            className="text-link text-sm hover:underline"
          >
            Older
          </Link>
        ) : null}
      </div>
    </>
  );
}

/**
 * What happened, with what it acted on linked to its page when it has one. An order or cart reads
 * by its short reference ("#qcs34m"), as everywhere else in the app.
 */
function What({ e }: { e: AuditEvent }) {
  const { label, target, details } = describeParts(e);
  const href = targetHref(e);
  const short = target && /^(ord|cart)_/.test(target) ? orderRef(target) : target;
  if (!target) return <>{details.length ? `${label}: ${details.join(', ')}` : label}</>;
  return (
    <>
      {label}:{' '}
      {href ? (
        <Link to={href} title={target} className="text-link hover:underline">
          {short}
        </Link>
      ) : (
        target
      )}
      {details.length ? `, ${details.join(', ')}` : ''}
    </>
  );
}
