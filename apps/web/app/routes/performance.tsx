import { Segmented, SegmentedItem } from '@orderloop/ui/segmented';
import { useLoaderData, useNavigation, useSearchParams } from 'react-router';
import { PageHeader, Section } from '~/components/page';
import { PerformanceDetail } from '~/components/performance';
import { Trends } from '~/components/trends';
import { requireUser } from '~/lib/auth.server';
import { performance } from '~/lib/metrics.server';
import { RANGES, toRange } from '~/lib/ranges';
import type { Route } from './+types/performance';

export const meta = () => [{ title: 'Performance · OrderLoop' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return performance(toRange(new URL(request.url).searchParams.get('days')));
}

/**
 * How the business is doing over 7, 30 or 90 days, for whoever watches it rather than works the
 * queue. One window governs the page: every figure counts the same orders and payments, so the
 * charts and the panels can't disagree.
 */
export default function Performance() {
  const p = useLoaderData<typeof loader>();
  const [, setParams] = useSearchParams();
  const busy = useNavigation().state === 'loading';
  return (
    <>
      <PageHeader
        title="Performance"
        subtitle={`The last ${p.days} days, as whole days in UTC up to today. Orders count on the day they ended; payments on the day they were taken.`}
        actions={
          <Segmented
            aria-label="Period"
            value={String(p.days)}
            onValueChange={(v) =>
              setParams({ days: v }, { replace: true, preventScrollReset: true })
            }
            className="text-xs"
          >
            {RANGES.map((r) => (
              <SegmentedItem key={r} value={String(r)} className="tabular">
                {`${r} days`}
              </SegmentedItem>
            ))}
          </Segmented>
        }
      />
      <div className="mx-auto max-w-page space-y-6 px-4 pb-10 sm:px-6" aria-busy={busy}>
        <Section title="Day by day">
          <Trends daily={p.daily} totals={p.totals} days={p.days} />
        </Section>
        <Section title="Over the period">
          <PerformanceDetail p={p} />
        </Section>
      </div>
    </>
  );
}
