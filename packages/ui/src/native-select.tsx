import { ChevronDownIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from './lib/utils';

function NativeSelect({
  className,
  wrapperClassName,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & {
  size?: 'sm' | 'default';
  /** Sizes the wrapper, which is content width by default; `w-full` fills the container. */
  wrapperClassName?: string;
}) {
  return (
    <div
      className={cn(
        'group/native-select relative w-fit has-[select:disabled]:opacity-50',
        wrapperClassName,
      )}
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          'h-9 w-full min-w-0 appearance-none rounded-4xl border border-input bg-input/30 py-0 pr-8 pl-3 text-sm transition-[color,box-shadow,background-color] outline-none select-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 dark:hover:bg-input/50',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
