import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches, following changes live. The server can't know the viewport, so
 * server rendering and the hydrating render both see `false`; pick the query so that `false` is
 * the safe answer (e.g. ask "is this wide enough to edit?", not "is this narrow?").
 */
export function useMedia(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tailwind's `lg`: the width the full flow editor, order and assistant layouts need. */
export const WIDE = '(min-width: 1024px)';
