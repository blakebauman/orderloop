import { Button } from '@orderloop/ui/button';
import { Copy } from 'lucide-react';
import { useState } from 'react';

/** Copies text, and says so for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      <Copy /> <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}
