/**
 * AI Elements' Suggestion (registry.ai-sdk.dev, radix-luma), in this repo's style. The suggestions
 * stack in a column (they're whole questions, too long for upstream's scrolling row), so there is no
 * scroll area.
 */

import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import type { ComponentProps } from 'react';

export const Suggestions = ({ className, ...props }: ComponentProps<'ul'>) => (
  <ul className={cn('flex flex-col items-start gap-1.5', className)} {...props} />
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = 'outline',
  size = 'sm',
  children,
  ...props
}: SuggestionProps) => (
  <li className="max-w-full">
    <Button
      className={cn('h-auto max-w-full whitespace-normal py-1.5 text-left text-ui', className)}
      onClick={() => onClick?.(suggestion)}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  </li>
);
