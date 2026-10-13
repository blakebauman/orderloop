import { Label as LabelPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from './lib/utils';

/**
 * A form label bound to its control.
 *
 * Added because there were none: across the four sheets there was not a single
 * `<label>` element, and every field leaned on its placeholder to say what it was.
 * A placeholder is not a name — it disappears the moment anyone types (WCAG 3.3.2),
 * and controls without one (a range slider, a bare textarea) had no name at all.
 *
 * Radix's Label rather than a plain element for one behaviour: clicking the text
 * focuses the control even when the control is a custom composite, which a native
 * `htmlFor` only manages for real form elements.
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-xs leading-none font-medium text-muted-foreground select-none',
        'group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
