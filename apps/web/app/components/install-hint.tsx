import { Button } from '@orderloop/ui/button';
import { Share, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '~/lib/device';

const DISMISSED = 'ol-install-dismissed';

/**
 * On an iPhone or iPad in Safari: how to put OrderLoop on the Home Screen, where it opens as its own
 * app without Safari's bars. iOS never offers this itself. Only on Account, never over work, and
 * gone for good once waved away.
 */
export function InstallHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED) === '1';
    } catch {}
    setShow(isIos() && !isStandalone() && !dismissed);
  }, []);
  if (!show) return null;
  return (
    <aside
      aria-label="Add to Home Screen"
      className="mb-6 flex items-start gap-3 rounded-lg border bg-card p-4"
    >
      <Share className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Put OrderLoop on your Home Screen.</span> In Safari, tap
        Share, then <span className="font-medium">Add to Home Screen</span>. It opens on its own,
        like an app, without Safari’s bars.
      </p>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Not now"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED, '1');
          } catch {
            // Private browsing: it asks again next visit, which is fine.
          }
          setShow(false);
        }}
      >
        <X />
      </Button>
    </aside>
  );
}
