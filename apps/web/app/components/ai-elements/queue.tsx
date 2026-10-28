/**
 * AI Elements' Queue (registry.ai-sdk.dev, radix-luma), in this repo's style, for messages waiting to
 * send. Kept: Queue, QueueList, QueueItem, QueueItemActions and QueueItemAction; the collapsible
 * sections, todos and attachments are left out. An item's actions stay visible on touch and on
 * keyboard focus, not only on hover.
 */

import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import type { ComponentProps } from 'react';

export const Queue = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn('flex flex-col gap-1 rounded-xl bg-muted/50 px-2 py-2', className)}
    {...props}
  />
);

export const QueueList = ({ className, ...props }: ComponentProps<'ul'>) => (
  <ul className={cn('max-h-40 space-y-0.5 overflow-y-auto', className)} {...props} />
);

export const QueueItem = ({ className, ...props }: ComponentProps<'li'>) => (
  <li
    className={cn(
      'group flex items-center gap-1.5 rounded-xl px-1 text-sm transition-colors hover:bg-muted',
      className,
    )}
    {...props}
  />
);

export const QueueItemActions = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex shrink-0 gap-1', className)} {...props} />
);

export type QueueItemActionProps = Omit<ComponentProps<typeof Button>, 'variant' | 'size'> & {
  label: string;
};

export const QueueItemAction = ({ className, label, ...props }: QueueItemActionProps) => (
  <Button
    className={cn(
      'hit-area size-6 text-muted-foreground hover:text-foreground fine:opacity-0 fine:group-hover:opacity-100 fine:focus-visible:opacity-100',
      className,
    )}
    size="icon-xs"
    type="button"
    variant="ghost"
    aria-label={label}
    title={label}
    {...props}
  />
);
