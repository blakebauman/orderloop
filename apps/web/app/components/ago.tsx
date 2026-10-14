import { ago, duration, waitLabel } from '~/lib/format';
import { useDateTime } from '~/lib/use-date-time';
import { useNow } from '~/lib/use-now';

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
 * recorded fall back to what they wait for.
 */
export function WaitingAt({
  at,
  since,
  on,
  prefix,
}: {
  at: string | null | undefined;
  since: number | null | undefined;
  on: string | null | undefined;
  /** Lead with "waiting at" (a step) or "waiting on" (what an older row records). */
  prefix?: boolean;
}) {
  const now = useNow(30_000);
  const formatTime = useDateTime();
  if (!at) return <>{`${prefix ? 'waiting on ' : ''}${waitLabel(on)}`}</>;
  return (
    <>
      {prefix ? 'waiting at ' : ''}
      {at}
      {since ? (
        <time
          dateTime={new Date(since).toISOString()}
          title={`Waiting since ${formatTime(since)}`}
          suppressHydrationWarning
        >
          {' '}
          · {duration(Math.max(0, now - since))}
        </time>
      ) : null}
    </>
  );
}
