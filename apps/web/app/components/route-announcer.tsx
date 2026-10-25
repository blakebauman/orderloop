import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';

/**
 * Says which page a navigation landed on, in a polite live region: a client-side navigation
 * changes the page without the browser announcing anything. It reads the page's h1 once it has
 * rendered (pages that load their data draw it a moment later), else the document title. Focus is
 * left where it was. A search change (a filter, a tab) is the same page and says nothing.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const first = useRef(true);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let tries = 0;
    let timer = 0;
    const look = () => {
      const h = document.querySelector('main h1') ?? document.querySelector('h1');
      const name = h?.textContent?.replace(/\s+/g, ' ').trim();
      if (!name && ++tries < 15) {
        timer = window.setTimeout(look, 100);
        return;
      }
      setSaid(name || document.title);
    };
    timer = window.setTimeout(look, 50);
    return () => clearTimeout(timer);
  }, [pathname]);
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {said}
    </p>
  );
}
