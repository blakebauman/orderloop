import { ago } from '~/lib/format';
import { useDateTime } from '~/lib/use-date-time';
import { useNow } from '~/lib/use-now';

/**
 * "3m ago" that stays true. The server and the browser compute it from different clocks, so the
 * hydrating render may be a unit off: the mismatch is allowed on this one element and corrected
 * right after hydration, then refreshed every 30 seconds. The full time is in the tooltip.
 */
export function Ago({ ms }: { ms: number | null | undefined }) {
  const now = useNow(30_000);
  const formatTime = useDateTime();
  if (!ms) return <>{ago(ms)}</>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatTime(ms)} suppressHydrationWarning>
      {ago(ms, now)}
    </time>
  );
}
