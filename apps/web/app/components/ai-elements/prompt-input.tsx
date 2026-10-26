/**
 * AI Elements' PromptInput (registry.ai-sdk.dev, radix-luma), cut down to the composer the assistant
 * uses: a form around an input group, its textarea, a footer and the submit button, which turns into
 * stop while a reply runs. Upstream's attachments, model select, command menu, hover cards and speech
 * input are left out. The text is controlled by the caller, and when Enter sends is the caller's
 * call (`sendOnEnter`): on a touch screen Return is a new line.
 */

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@orderloop/ui/input-group';
import { cn } from '@orderloop/ui/lib/utils';
import type { ChatStatus } from 'ai';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import type { ComponentProps, FormEvent, HTMLAttributes, KeyboardEvent } from 'react';

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => (
  <form
    className={cn('w-full', className)}
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit(e);
    }}
    {...props}
  >
    <InputGroup className="overflow-hidden">{children}</InputGroup>
  </form>
);

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea> & {
  /** Whether this Enter press sends; Shift+Enter and an IME composition never do. */
  sendOnEnter?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
};

export const PromptInputTextarea = ({
  className,
  sendOnEnter = () => true,
  onKeyDown,
  ...props
}: PromptInputTextareaProps) => (
  <InputGroupTextarea
    className={cn('field-sizing-content max-h-40 min-h-10 text-[13.5px]', className)}
    onKeyDown={(e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing)
        return;
      if (!sendOnEnter(e)) return;
      e.preventDefault();
      const form = e.currentTarget.form;
      const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (!submit?.disabled) form?.requestSubmit();
    }}
    {...props}
  />
);

export const PromptInputFooter = ({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupAddon>, 'align'>) => (
  <InputGroupAddon
    align="block-end"
    className={cn('justify-between gap-1', className)}
    {...props}
  />
);

export const PromptInputTools = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center gap-1', className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  /** Called instead of submitting while a reply is streaming. */
  onStop?: () => void;
};

/** Send, or stop while a reply is running (`status` streaming or submitted). */
export const PromptInputSubmit = ({
  status,
  onStop,
  className,
  variant = 'default',
  size = 'icon-sm',
  ...props
}: PromptInputSubmitProps) => {
  const running = status === 'streaming' || status === 'submitted';
  return running && onStop ? (
    <InputGroupButton
      aria-label="Stop the reply"
      title="Stop"
      className={className}
      size={size}
      type="button"
      variant="outline"
      onClick={onStop}
    >
      <SquareIcon className="size-3.5 fill-current" />
    </InputGroupButton>
  ) : (
    <InputGroupButton
      aria-label="Send"
      title="Send"
      className={className}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      <ArrowUpIcon className="size-4" />
    </InputGroupButton>
  );
};
