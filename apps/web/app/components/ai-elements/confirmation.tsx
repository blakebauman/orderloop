/**
 * AI Elements' Confirmation (registry.ai-sdk.dev, radix-luma), in this repo's style, for a tool call
 * that needs a person's yes: the request while it waits, then whichever of accepted or rejected
 * happened. Upstream's `@ts-expect-error`s for AI SDK 6 are gone; these states exist in 7.
 */

import { cn } from '@orderloop/ui/lib/utils';
import type { ToolUIPart } from 'ai';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';

type Approval = ToolUIPart['approval'];
type State = ToolUIPart['state'];

const ConfirmationContext = createContext<{ approval: Approval; state: State } | null>(null);

const useConfirmation = () => {
  const context = useContext(ConfirmationContext);
  if (!context) throw new Error('Confirmation components must be used within Confirmation');
  return context;
};

export type ConfirmationProps = ComponentProps<'section'> & {
  approval?: Approval;
  state: State;
};

/** Nothing until the call has asked for approval. */
export const Confirmation = ({ className, approval, state, ...props }: ConfirmationProps) => {
  if (!approval || state === 'input-streaming' || state === 'input-available') return null;
  return (
    <ConfirmationContext.Provider value={{ approval, state }}>
      <section className={cn('flex flex-col', className)} {...props} />
    </ConfirmationContext.Provider>
  );
};

const RESPONDED: State[] = [
  'approval-responded',
  'output-denied',
  'output-available',
  'output-error',
];

export const ConfirmationRequest = ({ children }: { children?: ReactNode }) =>
  useConfirmation().state === 'approval-requested' ? children : null;

export const ConfirmationAccepted = ({ children }: { children?: ReactNode }) => {
  const { approval, state } = useConfirmation();
  return approval?.approved === true && RESPONDED.includes(state) ? children : null;
};

export const ConfirmationRejected = ({ children }: { children?: ReactNode }) => {
  const { approval, state } = useConfirmation();
  return (approval?.approved === false && RESPONDED.includes(state)) || state === 'output-denied'
    ? children
    : null;
};

export const ConfirmationActions = ({ className, ...props }: ComponentProps<'div'>) =>
  useConfirmation().state === 'approval-requested' ? (
    <div className={cn('flex items-center justify-end gap-2', className)} {...props} />
  ) : null;
