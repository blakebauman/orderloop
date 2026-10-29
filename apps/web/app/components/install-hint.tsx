import { Button } from '@orderloop/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
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
    <Item asChild variant="outline" className="mb-6 items-start bg-card">
      <aside aria-label="Add to Home Screen">
        <ItemMedia variant="icon" className="text-muted-foreground">
          <Share aria-hidden="true" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="line-clamp-none">Put OrderLoop on your Home Screen.</ItemTitle>
          <ItemDescription className="line-clamp-none">
            In Safari, tap Share, then{' '}
            <span className="font-medium text-foreground">Add to Home Screen</span>. It opens on its
            own, like an app, without Safari’s bars.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
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
        </ItemActions>
      </aside>
    </Item>
  );
}
