import { useEffect, useRef } from 'react';

/** How long a key counts as new: long enough to outlast a re-render mid-animation. */
const FRESH_MS = 400;

/**
 * The keys that count as new: unseen in `known` (when each was first seen), or seen less than
 * `FRESH_MS` ago and still animating. None while nothing is known yet, or when more than `burst`
 * are new at once.
 */
export function freshKeys(
  keys: readonly string[],
  known: ReadonlyMap<string, number> | null,
  now: number,
  burst: number,
): Set<string> {
  const fresh = new Set<string>();
  if (!known) return fresh;
  for (const k of keys) {
    const at = known.get(k);
    if (at === undefined || now - at < FRESH_MS) fresh.add(k);
  }
  if (fresh.size > burst) fresh.clear();
  return fresh;
}

/**
 * Which of `keys` arrived since the page first drew them, so only rows or entries that are
 * actually new animate in (`animate-arrive`), never what was already on screen or a whole refresh.
 *
 * Nothing is new on the first render, after `scope` changes (another filter or page is a new list,
 * not arrivals), while the page is hidden (a tab coming back shows the current state at once), or
 * when more than `burst` keys land together: a burst is a refresh, and animating it would play a
 * backlog.
 */
export function useArrivals(
  keys: readonly string[],
  { scope = '', burst = 5 }: { scope?: string; burst?: number } = {},
): (key: string) => boolean {
  // When each key was first seen, for the list `scope` names; null until a render is committed.
  const seen = useRef<{ scope: string; at: Map<string, number> } | null>(null);
  const now = Date.now();
  const known = seen.current?.scope === scope ? seen.current.at : null;
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  const fresh = visible ? freshKeys(keys, known, now, burst) : new Set<string>();
  useEffect(() => {
    // Keys animating now are stamped, so a re-render mid-animation keeps them; anything else that
    // is unseen (the first render, a hidden page, a burst) is recorded as long settled.
    // Only the keys on screen are kept, so a long-open page doesn't accumulate them.
    const at = Date.now();
    const next = new Map<string, number>();
    for (const k of keys) next.set(k, known?.get(k) ?? (fresh.has(k) ? at : 0));
    seen.current = { scope, at: next };
  });
  return (key) => fresh.has(key);
}
