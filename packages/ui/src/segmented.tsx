import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from './lib/utils';

/**
 * One choice of a few, as a pill track with the chosen segment raised (the preset's tab list). A
 * radio group: arrow keys move the choice, and with a `name` it posts with its form.
 */
function Segmented({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented"
      orientation="horizontal"
      className={cn(
        'inline-grid auto-cols-fr grid-flow-col gap-1 rounded-full bg-muted p-1 text-ui',
        className,
      )}
      {...props}
    />
  );
}

function SegmentedItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="segmented-item"
      className={cn(
        "hit-area inline-flex min-h-7 items-center justify-center gap-1.5 rounded-full border border-transparent px-3 py-1 whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:bg-background data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[state=checked]:shadow-sm dark:data-[state=checked]:bg-input/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { Segmented, SegmentedItem };
