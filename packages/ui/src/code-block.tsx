import { cva, type VariantProps } from 'class-variance-authority';
import { Check, Copy } from 'lucide-react';
import * as React from 'react';

import { Button } from './button';
import { cn } from './lib/utils';

const codeBlockVariants = cva(
  'group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl text-sm has-[>[data-slot=code-block-content]:focus-visible]:ring-[3px] has-[>[data-slot=code-block-content]:focus-visible]:ring-ring/50 data-[size=sm]:rounded-lg data-[size=sm]:text-xs',
  {
    variants: {
      variant: {
        default:
          'border border-input bg-muted/40 text-foreground has-[>[data-slot=code-block-content]:focus-visible]:border-ring dark:bg-input/30',
        destructive: 'border border-bad/30 text-bad dark:border-bad/40',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function CodeBlock({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<'div'> &
  VariantProps<typeof codeBlockVariants> & { size?: 'default' | 'sm' }) {
  return (
    <div
      data-slot="code-block"
      data-variant={variant}
      data-size={size}
      className={cn(codeBlockVariants({ variant }), className)}
      {...props}
    />
  );
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 px-4 pt-4 text-muted-foreground group-data-[size=sm]/code-block:px-3 group-data-[size=sm]/code-block:pt-3 group-data-[variant=destructive]/code-block:text-bad',
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-title"
      className={cn(
        'min-w-0 truncate font-medium font-sans text-foreground text-sm group-data-[size=sm]/code-block:text-xs',
        className,
      )}
      {...props}
    />
  );
}

/** Beside the title in a header; on its own, it floats in the corner and shows on hover or focus. */
function CodeBlockActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn(
        '-my-1 -me-1.5 ms-auto flex shrink-0 items-center gap-1 [[data-slot=code-block]>&]:absolute [[data-slot=code-block]>&]:end-3 [[data-slot=code-block]>&]:top-3 [[data-slot=code-block]>&]:z-10 [[data-slot=code-block]>&]:m-0 [[data-slot=code-block]>&]:opacity-0 [[data-slot=code-block]>&]:transition-opacity [[data-slot=code-block]>&]:group-focus-within/code-block:opacity-100 [[data-slot=code-block]>&]:group-hover/code-block:opacity-100 group-data-[size=sm]/code-block:[[data-slot=code-block]>&]:end-2 group-data-[size=sm]/code-block:[[data-slot=code-block]>&]:top-2 [[data-slot=code-block]>&]:pointer-coarse:opacity-100 [[data-slot=code-block]>&]:*:[button]:bg-background [[data-slot=code-block]>&]:*:[button]:ring-1 [[data-slot=code-block]>&]:*:[button]:ring-foreground/10',
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockCopyButton({
  value,
  variant = 'ghost',
  size = 'icon-xs',
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button> & { value: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <>
      <Button
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        variant={variant}
        size={size}
        aria-label={copied ? 'Copied' : 'Copy'}
        className={className}
        onClick={(event) => {
          onClick?.(event);
          navigator.clipboard
            .writeText(value)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
        {...props}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}

/** The code, scrolling on its own (or wrapping, with `wrap`). It takes focus so a keyboard can scroll it. */
function CodeBlockContent({
  className,
  children,
  wrap = false,
  ...props
}: React.ComponentProps<'pre'> & { wrap?: boolean }) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      dir="ltr"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
      tabIndex={0}
      className={cn(
        'min-h-0 min-w-0 overflow-auto px-4 py-4 text-start font-mono leading-relaxed outline-none group-has-data-[slot=code-block-header]/code-block:pt-2 group-data-[size=sm]/code-block:px-3 group-data-[size=sm]/code-block:py-3 group-data-[size=sm]/code-block:group-has-data-[slot=code-block-header]/code-block:pt-1.5 data-wrap:wrap-break-word data-wrap:whitespace-pre-wrap',
        className,
      )}
      {...props}
    >
      <code
        data-slot="code-block-code"
        className="grid min-h-lh min-w-max content-start in-data-wrap:min-w-0"
      >
        {children}
      </code>
    </pre>
  );
}

function CodeBlockLine({ className, children, ...props }: React.ComponentProps<'span'>) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty =
    children === undefined ||
    children === null ||
    children === '' ||
    (Array.isArray(children) && children.length === 0);
  return (
    <span data-slot="code-block-line" className={cn('block min-h-lh', className)} {...props}>
      {empty ? '\n' : children}
    </span>
  );
}

export {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
};
