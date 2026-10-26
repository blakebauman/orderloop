/**
 * AI Elements' Conversation (registry.ai-sdk.dev, radix-luma), in this repo's style: the message
 * list follows a reply while the reader is at the bottom and stops when they scroll up, with a
 * button back to the latest.
 */

import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import { ArrowDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-5 p-4', className)} {...props} />
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return isAtBottom ? null : (
    <Button
      className={cn('hit-area absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm', className)}
      onClick={() => void scrollToBottom()}
      size="icon-sm"
      type="button"
      variant="outline"
      aria-label="Scroll to the latest"
      title="Scroll to the latest"
      {...props}
    >
      <ArrowDownIcon />
    </Button>
  );
};
