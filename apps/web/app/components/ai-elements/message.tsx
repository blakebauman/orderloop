/**
 * AI Elements' Message (registry.ai-sdk.dev, radix-luma), in this repo's style. Kept: Message,
 * MessageContent, MessageActions, MessageAction and MessageResponse. Branches and attachments are
 * left out (the assistant has neither), and an action's label is its `title` rather than a tooltip.
 */

import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import type { UIMessage } from 'ai';
import { type ComponentProps, type HTMLAttributes, memo } from 'react';
import { Streamdown } from 'streamdown';

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role'];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-1.5',
      from === 'user' ? 'is-user ml-auto max-w-[88%] items-end' : 'is-assistant',
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'flex w-fit min-w-0 max-w-full flex-col gap-2 text-[13.5px]',
      'group-[.is-user]:rounded-2xl group-[.is-user]:bg-secondary group-[.is-user]:px-3.5 group-[.is-user]:py-2 group-[.is-user]:whitespace-pre-wrap',
      'group-[.is-assistant]:w-full',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<'div'>;

/** Shown under a message; on a fine pointer they wait for hover or focus. */
export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div
    className={cn(
      // On touch, apart enough that each one's 44px touch area is its own.
      'flex items-center gap-0.5 touch:gap-5 fine:opacity-0 fine:transition-opacity fine:group-hover:opacity-100 fine:focus-within:opacity-100',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  label: string;
};

export const MessageAction = ({
  label,
  children,
  variant = 'ghost',
  size = 'icon-xs',
  className,
  ...props
}: MessageActionProps) => (
  <Button
    size={size}
    type="button"
    variant={variant}
    title={label}
    aria-label={label}
    className={cn('text-muted-foreground hover:text-foreground', className)}
    {...props}
  >
    {children}
  </Button>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

/** Markdown from the model, re-rendered only when its text changes. */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating,
);

MessageResponse.displayName = 'MessageResponse';
