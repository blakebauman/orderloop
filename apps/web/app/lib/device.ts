import { useCallback, useEffect, useSyncExternalStore } from 'react';

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

/** A finger rather than a mouse or trackpad, checked when it matters (an Enter key, say). */
export const coarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * While mounted, mirrors the visual viewport (what's left above the on-screen keyboard) into CSS:
 * `--vvh` and `--vvtop` on <html>, and `data-keyboard` while the keyboard is up, so a fixed panel
 * can pin itself to the visible area. iPadOS doesn't resize the page for its keyboard and the
 * window shrinks along with it, so "up" means the visible height is under 80% of the tallest seen
 * at this width; the tallest resets when the width changes (rotation, Split View).
 */
export function useVisualViewport(active = true) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    let width = 0;
    let tallest = 0;
    const update = () => {
      if (vv.width !== width) {
        width = vv.width;
        tallest = 0;
      }
      tallest = Math.max(tallest, vv.height);
      root.style.setProperty('--vvh', `${vv.height}px`);
      root.style.setProperty('--vvtop', `${vv.offsetTop}px`);
      root.toggleAttribute('data-keyboard', vv.height < tallest * 0.8);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.removeAttribute('data-keyboard');
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvtop');
    };
  }, [active]);
}
