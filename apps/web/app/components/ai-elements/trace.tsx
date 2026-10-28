/**
 * shadcn's Trace (ui.shadcn.com/docs/components/radix/trace), in this repo's style: what the
 * assistant did in a turn, as lines of icon, title and an optional description. A line can open to
 * show more (TraceCollapsible) or be wrapped in a link. Status is said by the title's words; colour
 * and the shimmer only repeat it. An error is `bad`, a running title shimmers (still where motion is
 * reduced), and a pending line is faint.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@orderloop/ui/collapsible';
import { cn } from '@orderloop/ui/lib/utils';
import { ChevronRight } from 'lucide-react';
import type * as React from 'react';

export type TraceStatus = 'running' | 'error' | 'pending';

function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="trace"
      className={cn(
        // A link or button wrapping a line is sized to it and takes the focus ring.
        'flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:rounded-lg *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-[3px] *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<'span'> & { status?: TraceStatus }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        'flex w-fit min-w-0 max-w-full items-center gap-2 text-[12.5px] text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-bad data-[status=error]:in-[a:hover,button:hover]:text-bad data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:ol-shimmer',
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [[data-slot=trace-title]~&]:-ml-1",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('min-w-0 truncate', className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      className={cn('shrink-0 text-muted-foreground/70 tabular', className)}
      {...props}
    />
  );
}

function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, 'asChild'>) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn('flex w-full min-w-0 flex-col', className)}
      {...props}
    />
  );
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsibleTrigger>, 'asChild'>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        'group/trace-trigger hit-area flex w-fit min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-lg text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 has-[[data-status=error]]:text-bad',
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-aria-expanded/trace-trigger:rotate-90 motion-reduce:transition-none">
        <ChevronRight />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsibleContent>, 'asChild'>) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className="min-w-0 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          'mt-2 mb-1 ml-[calc(--spacing(1.75)-1px)] min-w-0 wrap-break-word border-l pr-1 pl-4 text-[12.5px] text-muted-foreground leading-relaxed',
          className,
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
};
