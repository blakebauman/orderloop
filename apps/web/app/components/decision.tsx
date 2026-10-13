/**
 * Approve / reject with a note and a short undo window. Nothing is sent until the window closes, so
 * "Undo" is real: the order's Workflow never hears about a decision that was taken back.
 * Shared by the approvals inbox and the order page; each passes its own transport.
 */

import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { Check, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ApprovalContext } from '~/lib/approvals';
import { until } from '~/lib/format';
import { useDateTime } from '~/lib/use-date-time';

const UNDO_MS = 5000;

export type Decision = 'approved' | 'rejected';

/** The reason, the figures behind it, and the escalation clock. */
export function DecisionContext({ ctx, className }: { ctx: ApprovalContext; className?: string }) {
  const now = useNow(ctx.deadline ? 1000 : null);
  const formatTime = useDateTime();
  if (!ctx.reason && !ctx.facts.length && !ctx.deadline) return null;
  return (
    <div className={cn('text-sm', className)}>
      {ctx.reason ? <p className="font-medium text-foreground">{ctx.reason}</p> : null}
      {ctx.facts.length || ctx.deadline ? (
        <p className="mt-0.5 text-muted-foreground text-xs tabular">
          {ctx.facts.join(' · ')}
          {ctx.facts.length && ctx.deadline ? ' · ' : ''}
          {ctx.deadline ? (
            <span
              className={cn(ctx.deadline - now < 10 * 60_000 && 'font-medium text-wait')}
              title={formatTime(ctx.deadline)}
              suppressHydrationWarning
            >
              {ctx.onTimeout
                ? until(ctx.deadline, now) === 'overdue'
                  ? `Going to ${ctx.onTimeout} now`
                  : `If no one decides ${until(ctx.deadline, now)}: ${ctx.onTimeout}`
                : until(ctx.deadline, now) === 'overdue'
                  ? 'Escalation due now'
                  : `Escalates ${until(ctx.deadline, now)}`}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function DecisionControls({
  onDecide,
  disabled,
  busy,
  compact,
  shortcuts,
  onPendingChange,
  onFlush,
  only,
  defaultNote = '',
}: {
  onDecide: (decision: Decision, note: string) => void;
  disabled?: boolean;
  /** The decision has been sent and is being recorded. */
  busy?: boolean;
  compact?: boolean;
  /** Listen for A / R / Z on this element's row (inbox keyboard path). */
  shortcuts?: React.RefObject<HTMLElement | null>;
  /** Told when an undo window opens and closes, so a list can hold still meanwhile. */
  onPendingChange?: (pending: boolean) => void;
  /**
   * Sends a decision whose undo window was cut short (the control unmounted or the page is being
   * left). It must survive navigation, so use `sendDecision` rather than page-bound transports.
   */
  onFlush?: (decision: Decision, note: string) => void;
  /** Offer just this decision (e.g. confirming one the chat agent prepared). */
  only?: Decision;
  defaultNote?: string;
}) {
  const [note, setNote] = useState(defaultNote);
  const [pending, setPending] = useState<{ decision: Decision; at: number } | null>(null);
  const now = useNow(pending ? 250 : null);
  const noteId = useId();
  const commit = useRef(onDecide);
  commit.current = onDecide;
  const report = useRef(onPendingChange);
  report.current = onPendingChange;
  // A decision the person made is never silently dropped: if the window is cut short, send it now.
  const latest = useRef({ pending, note, flush: onFlush });
  latest.current = { pending, note, flush: onFlush };
  useEffect(() => {
    const flush = () => {
      const { pending: p, note: n, flush: f } = latest.current;
      if (!p) return;
      latest.current.pending = null;
      (f ?? commit.current)(p.decision, n.trim());
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);
  const isPending = !!pending;
  useEffect(() => {
    if (!isPending) return;
    report.current?.(true);
    return () => report.current?.(false);
  }, [isPending]);

  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => {
      latest.current.pending = null;
      commit.current(pending.decision, note.trim());
      setPending(null);
    }, UNDO_MS);
    return () => window.clearTimeout(t);
  }, [pending, note]);

  useEffect(() => {
    const el = shortcuts?.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (pending && (k === 'z' || k === 'escape')) {
        e.preventDefault();
        setPending(null);
      } else if (!pending && !disabled && !busy && (k === 'a' || k === 'r')) {
        e.preventDefault();
        setPending({ decision: k === 'a' ? 'approved' : 'rejected', at: Date.now() });
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [shortcuts, pending, disabled, busy]);

  if (busy) {
    return (
      <p className="text-muted-foreground text-sm" aria-live="polite">
        Recording decision…
      </p>
    );
  }

  if (pending) {
    const left = Math.max(0, Math.ceil((pending.at + UNDO_MS - now) / 1000));
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/50 px-3 py-2 text-sm"
        aria-live="polite"
      >
        <span>
          {pending.decision === 'approved' ? 'Approving' : 'Rejecting'} in{' '}
          <span className="tabular">{left}s</span>
          {note.trim() ? <span className="text-muted-foreground"> · with note</span> : null}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setPending(null)}
          autoFocus
        >
          Undo
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', compact && 'sm:flex-nowrap')}>
      <label htmlFor={noteId} className="sr-only">
        Note for the order history
      </label>
      <Input
        id={noteId}
        placeholder="Note (optional)"
        className={cn('h-8 text-sm', compact ? 'w-full sm:w-48' : 'w-full')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={disabled}
      />
      <div className="flex gap-2">
        {only !== 'rejected' ? (
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => setPending({ decision: 'approved', at: Date.now() })}
          >
            <Check /> Approve
          </Button>
        ) : null}
        {only !== 'approved' ? (
          <Button
            size="sm"
            variant={only ? 'default' : 'outline'}
            disabled={disabled}
            onClick={() => setPending({ decision: 'rejected', at: Date.now() })}
          >
            <X /> Reject
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A clock that ticks only while something on screen depends on it. */
function useNow(interval: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!interval) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(t);
  }, [interval]);
  return now;
}

/**
 * Records a decision through the order's action route with `keepalive`, so it still arrives when
 * the page is being closed or navigated away from.
 */
export function sendDecision(orderId: string, nodeId: string, decision: Decision, note: string) {
  const body = new FormData();
  body.set('intent', decision === 'approved' ? 'approve' : 'reject');
  body.set('nodeId', nodeId);
  if (note) body.set('note', note);
  void fetch(`/orders/${orderId}/action`, { method: 'POST', body, keepalive: true }).catch(
    () => {},
  );
}
