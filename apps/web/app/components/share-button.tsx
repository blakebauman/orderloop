import { Button } from '@orderloop/ui/button';
import { Link2, Share } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * Shares this page's link: through the system share sheet where there is one (iPhone, iPad, most
 * phones), else by copying it. The server can't know which, so it renders the copy button and the
 * client swaps in Share once hydrated.
 */
export function ShareButton({ title }: { title: string }) {
  const canShare = useSyncExternalStore(
    subscribe,
    () => typeof navigator.share === 'function',
    () => false,
  );
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={async () => {
        const url = window.location.href;
        if (canShare) {
          // Dismissing the sheet rejects; that's an answer, not an error.
          await navigator.share({ title, url }).catch(() => {});
          return;
        }
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {canShare ? <Share /> : <Link2 />}{' '}
      <span aria-live="polite">{canShare ? 'Share' : copied ? 'Copied' : 'Copy link'}</span>
    </Button>
  );
}
