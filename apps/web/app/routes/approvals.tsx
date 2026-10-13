import { ORDER_TYPE_LABELS, type OrderType } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Check, X } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import { Empty, PageHeader } from '~/components/page';
import { StatusBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { ago, money, shortId } from '~/lib/format';
import { listApprovals } from '~/lib/orders.server';
import type { Route } from './+types/approvals';

export const meta = () => [{ title: 'Approvals · Order Loop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  return { status, rows: await listApprovals(status) };
}

export default function Approvals() {
  const { rows, status } = useLoaderData<typeof loader>();
  const [, setParams] = useSearchParams();
  const { revalidate } = useRevalidator();
  useEffect(() => {
    const t = window.setInterval(() => revalidate(), 5000);
    return () => window.clearInterval(t);
  }, [revalidate]);
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Every approval node waiting across all orders. Deciding here resumes that order’s Workflow."
        actions={
          <div className="flex rounded-lg border p-0.5 text-xs">
            {['pending', 'approved', 'rejected', 'escalated', 'all'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setParams({ status: s })}
                className={`rounded-md px-2.5 py-1 capitalize ${status === s ? 'bg-muted' : 'text-muted-foreground'}`}
              >
                {s}
              </button>
            ))}
          </div>
        }
      />
      <div className="mx-auto max-w-[1400px] space-y-2 px-6 pb-10">
        {rows.length ? (
          rows.map((r) => <Row key={r.id} r={r} />)
        ) : (
          <Empty>Nothing {status === 'all' ? '' : status} here.</Empty>
        )}
      </div>
    </>
  );
}

function Row({ r }: { r: Awaited<ReturnType<typeof listApprovals>>[number] }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const pending = r.status === 'pending' && fetcher.state === 'idle' && !fetcher.data?.ok;
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-md border bg-card px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm">{r.title}</div>
        <div className="text-muted-foreground text-xs">
          <Link to={`/orders/${r.orderId}`} className="font-mono hover:underline">
            {shortId(r.orderId)}
          </Link>
          {r.orderType ? ` · ${ORDER_TYPE_LABELS[r.orderType as OrderType]}` : ''} · for{' '}
          <b>{r.assignee}</b> · requested {ago(r.requestedAt)}
          {r.decidedBy ? ` · ${r.status} by ${r.decidedBy}` : ''}
          {r.note ? ` — “${r.note}”` : ''}
        </div>
        {fetcher.data?.error ? <div className="text-bad text-xs">{fetcher.data.error}</div> : null}
      </div>
      <div className="font-semibold tabular">{money(r.amount)}</div>
      {pending ? (
        <fetcher.Form method="post" action={`/orders/${r.orderId}/action`} className="flex gap-2">
          <input type="hidden" name="nodeId" value={r.nodeId} />
          <Button size="sm" name="intent" value="approve">
            <Check /> Approve
          </Button>
          <Button size="sm" variant="outline" name="intent" value="reject">
            <X /> Reject
          </Button>
        </fetcher.Form>
      ) : (
        <StatusBadge
          status={
            fetcher.data?.ok
              ? 'running'
              : r.status === 'approved'
                ? 'succeeded'
                : r.status === 'pending'
                  ? 'waiting'
                  : 'cancelled'
          }
        />
      )}
    </div>
  );
}
