import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Form, Link, useLoaderData, useSubmit } from 'react-router';
import { Ago } from '~/components/ago';
import { Empty, PageHeader, Section } from '~/components/page';
import { AUDIT_GROUPS, describe, isAuditGroup } from '~/lib/audit';
import { listAudit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import type { Route } from './+types/audit';

export const meta = () => [{ title: 'Audit log · OrderLoop' }];

const PAGE = 100;

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
        subtitle="Sign-ins, team and token changes, and refused API attempts, newest first. Kept 180 days."
        crumbs={<Link to="/team">Team</Link>}
      />
      <div className="mx-auto max-w-[1400px] space-y-4 px-4 pb-10 sm:px-6">
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left">
                  <tr>
                    <th scope="col" className="caption px-4 py-2 font-medium">
                      When
                    </th>
                    <th scope="col" className="caption px-2 py-2 font-medium">
                      Who
                    </th>
                    <th scope="col" className="caption px-2 py-2 font-medium">
                      What
                    </th>
                    <th scope="col" className="caption px-4 py-2 font-medium">
                      From
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {events.map((e) => (
                    <tr
                      key={e.id}
                      className={
                        e.action.endsWith('_failed') || e.action.endsWith('_throttled')
                          ? 'text-wait'
                          : undefined
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-1.5 text-muted-foreground text-xs">
                        <Ago ms={e.at} />
                      </td>
                      <td className="px-2 py-1.5">{e.actor ?? '—'}</td>
                      <td className="px-2 py-1.5">{describe(e)}</td>
                      <td className="px-4 py-1.5 font-mono text-muted-foreground text-xs">
                        {e.ip}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
