/**
 * shadcn's Message Scroller (ui.shadcn.com/docs/components/radix/message-scroller), in this repo's
 * style: the conversation keeps the reader's place. A new turn (an item with `scrollAnchor`) is
 * brought near the top while its reply streams in below; once the reply fills the view it is
 * followed, until the reader scrolls away. The button goes back to the latest.
 */

import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
} from '@shadcn/react/message-scroller';
import { ArrowDown } from 'lucide-react';
import type * as React from 'react';

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        // Hidden only for the frame before a saved thread is scrolled to its place.
        'ol-scroll size-full min-h-0 min-w-0 overflow-y-auto outline-none contain-content focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset data-pending-scroll:invisible',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn('flex h-max min-h-full flex-col gap-5 p-4', className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  );
}

/** Back to the latest; there only while the reader is away from it. */
function MessageScrollerButton({
  className,
  ...props
}: Omit<React.ComponentProps<typeof MessageScrollerPrimitive.Button>, 'direction' | 'render'>) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      direction="end"
      className={cn(
        'hit-area absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm transition-[translate,scale,opacity] duration-200 motion-reduce:transition-none data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100',
        className,
      )}
      render={<Button variant="outline" size="icon-sm" />}
      aria-label="Scroll to the latest"
      title="Scroll to the latest"
      {...props}
    >
      <ArrowDown />
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
};
