import { cn } from '@orderloop/ui/lib/utils';
import { ago, duration, waitLabel } from '~/lib/format';
import { useDateTime } from '~/lib/use-date-time';
import { useNow } from '~/lib/use-now';
import { isOverdue } from '~/lib/where';

/**
 * "3m ago" that stays true. The server and the browser compute it from different clocks, so the
 * hydrating render may be a unit off: the mismatch is allowed on this one element and corrected
 * right after hydration, then refreshed every 30 seconds. The full time is in the tooltip.
 */
export function Ago({ ms }: { ms: number | null | undefined }) {
  // Seconds matter while something is fresh; after a minute, refresh twice a minute.
  const now = useNow(ms && Date.now() - ms < 60_000 ? 1000 : 30_000);
  const formatTime = useDateTime();
  if (!ms) return <>{ago(ms)}</>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatTime(ms)} suppressHydrationWarning>
      {ago(ms, now)}
    </time>
  );
}

/**
 * Where an order is held and for how long: "Sales approval · 24h". Orders indexed before steps were
 * recorded fall back to what they wait for. A wait past its step's deadline (`due`) says so, in the
 * wait colour; one on time doesn't, however long it has waited.
 */
export function WaitingAt({
  at,
  since,
  on,
  due,
  prefix,
}: {
  at: string | null | undefined;
  since: number | null | undefined;
  on: string | null | undefined;
  /** When the wait times out; none (a timer) is never overdue. */
  due?: number | null;
  /** Lead with "waiting at" (a step) or "waiting on" (what an older row records). */
  prefix?: boolean;
}) {
  const now = useNow(30_000);
  const formatTime = useDateTime();
  if (!at) return <>{`${prefix ? 'waiting on ' : ''}${waitLabel(on)}`}</>;
  const late = isOverdue(due, now);
  return (
    <>
      {prefix ? 'waiting at ' : ''}
      {at}
      {since ? (
        <span className={cn(late && 'font-medium text-wait')}>
          <time
            dateTime={new Date(since).toISOString()}
            title={`Waiting since ${formatTime(since)}${late && due ? `, overdue since ${formatTime(due)}` : ''}`}
            suppressHydrationWarning
          >
            {' '}
            · {duration(Math.max(0, now - since))}
          </time>
          {late ? ' · overdue' : null}
        </span>
      ) : null}
    </>
  );
}
