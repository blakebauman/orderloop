/**
 * Cloudflare Turnstile's challenge, inside a form that posts to an action checking it
 * (`checkTurnstile` in lib/turnstile.server.ts). The widget writes its token into the form as
 * `cf-turnstile-response`. Its script is loaded only by this component, so only on the pages that
 * render it, whose CSP alone allows it.
 */

import { useEffect, useRef, useState } from 'react';

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileApi = {
  render(el: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(id: string): void;
  remove(id: string): void;
};

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const ready = (window as { turnstile?: TurnstileApi }).turnstile;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = (window as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else reject(new Error('Turnstile did not load'));
    };
    script.onerror = () => {
      // Blocked or offline: the next mount tries again.
      loading = null;
      script.remove();
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Whether this document was loaded at this page. The CSP that admits Turnstile is the one sent
 * with sign-in and setup; arriving from another page in the app (a session that ran out, say)
 * keeps that page's policy, which would block the script.
 */
function loadedHere(): boolean {
  const nav = performance.getEntriesByType('navigation')[0];
  return !nav || new URL(nav.name).pathname === window.location.pathname;
}

/**
 * The challenge. `onSolved` reports whether the form holds a token it can send. A new `reset`
 * (each answer from the action) runs the challenge again: a token works once, so a refused
 * attempt needs a fresh one.
 */
export function Turnstile({
  siteKey,
  action,
  reset,
  onSolved,
}: {
  siteKey: string;
  action: string;
  reset?: unknown;
  onSolved: (solved: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const solved = useRef(onSolved);
  solved.current = onSolved;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!loadedHere()) {
      window.location.reload();
      return;
    }
    let gone = false;
    loadTurnstile().then(
      (api) => {
        const el = box.current;
        if (gone || !el) return;
        const id = api.render(el, {
          sitekey: siteKey,
          action,
          theme: 'auto',
          // `flexible` fills the card; below its 300px minimum (the narrowest phones) the
          // compact widget fits instead of overflowing.
          size: el.clientWidth < 300 ? 'compact' : 'flexible',
          callback: () => {
            setFailed(false);
            solved.current(true);
          },
          'expired-callback': () => solved.current(false),
          'timeout-callback': () => solved.current(false),
          'error-callback': () => {
            setFailed(true);
            solved.current(false);
          },
        });
        if (id) widget.current = { api, id };
      },
      () => !gone && setFailed(true),
    );
    return () => {
      gone = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey, action]);

  // Runs again for each answer from the action, which is what `reset` is.
  useEffect(() => {
    if (!widget.current) return;
    widget.current.api.reset(widget.current.id);
    solved.current(false);
  }, [reset]);

  return (
    <div className="mt-4">
      {/* The widget's own height, held while it loads so the button below doesn't jump. */}
      <div ref={box} className="min-h-[65px]" />
      {failed ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          The security check couldn’t run. Reload the page; if it keeps failing, your network may be
          blocking challenges.cloudflare.com.
        </p>
      ) : null}
    </div>
  );
}
