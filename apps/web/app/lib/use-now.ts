import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `interval` ms (none when null). The first render uses the
 * render's own clock, so a server render and the hydrating render can differ: elements that show
 * it need `suppressHydrationWarning`. The effect refreshes it as soon as the page hydrates.
 */
export function useNow(interval: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!interval) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(t);
  }, [interval]);
  return now;
}
