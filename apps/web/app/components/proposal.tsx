import { type ChatProposal, type OrderState, TERMINAL_ORDER_STATUSES } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { useState } from 'react';
import { DecisionControls, sendDecision } from './decision';

type Call = (label: string, method: string, args: unknown[]) => Promise<unknown>;

/**
 * An action the chat agent prepared. Nothing happens until a person confirms it here, and a
 * decision still gets the usual undo window.
 */
export function Proposal({
  p,
  state,
  busy,
  call,
  by,
}: {
  p: ChatProposal;
  state: OrderState;
  busy: string | null;
  call: Call;
  by: string;
}) {
  const [done, setDone] = useState<null | 'sent' | 'dismissed'>(null);
  const note = (text: string) => <p className="mt-2 text-muted-foreground text-xs">{text}</p>;
  if (done === 'dismissed') return note('Dismissed. Nothing was sent.');
  if (done === 'sent') return note('Sent.');
  const dismiss = (
    <Button type="button" size="sm" variant="ghost" onClick={() => setDone('dismissed')}>
      Dismiss
    </Button>
  );
  if (p.kind === 'decide') {
    const open = state.waits.some((w) => w.kind === 'approval' && w.nodeId === p.nodeId);
    if (!open) return note('That step is no longer waiting, so there is nothing to confirm.');
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        <DecisionControls
          compact
          only={p.decision}
          defaultNote={p.note ?? ''}
          busy={busy === 'decide'}
          disabled={!!busy}
          onDecide={(decision, n) => {
            setDone('sent');
            void call('decide', 'decide', [p.nodeId, decision, `${by} via chat`, n || undefined]);
          }}
          onFlush={(decision, n) => sendDecision(state.orderId!, p.nodeId, decision, n)}
        />
        {dismiss}
      </div>
    );
  }
  if (TERMINAL_ORDER_STATUSES.includes(state.status))
    return note('The order has already finished, so there is nothing to cancel.');
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={!!busy}
        onClick={() => {
          setDone('sent');
          void call('cancel', 'cancel', [p.reason]);
        }}
      >
        Cancel order
      </Button>
      {dismiss}
    </div>
  );
}
