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
import { useNow } from '~/lib/use-now';

const UNDO_MS = 5000;
/** Time a decision needs to reach the order before its step times out. */
const SEND_MS = 1500;

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
                  ? 'Times out now'
                  : `Times out ${until(ctx.deadline, now)}`}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function DecisionControls({
  onDecide,
  deadline,
  onTimeout,
  disabled,
  busy,
  compact,
  shortcuts,
  onPendingChange,
  onFlush,
  defaultNote = '',
}: {
  onDecide: (decision: Decision, note: string) => void;
  /** When the step times out. The undo window never runs past it. */
  deadline?: number;
  /** What the flow does on timeout, e.g. "Decline order". */
  onTimeout?: string;
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
  defaultNote?: string;
}) {
  const [note, setNote] = useState(defaultNote);
  // `ms` is this decision's undo window: shorter than usual when the step is about to time out.
  const [pending, setPending] = useState<{ decision: Decision; at: number; ms: number } | null>(
    null,
  );
  // Near the deadline, tick so the controls lock before a decision could arrive too late.
  const nearDeadline = deadline !== undefined && deadline - Date.now() < UNDO_MS + 60_000;
  const now = useNow(pending ? 250 : nearDeadline ? 1000 : null);
  /** The undo window a decision made at `at` gets, or null when it could no longer arrive in time. */
  const windowFor = (at: number) => {
    if (deadline === undefined) return UNDO_MS;
    const ms = Math.min(UNDO_MS, deadline - at - SEND_MS);
    return ms >= 500 ? ms : null;
  };
  const decide = (decision: Decision) => {
    const at = Date.now();
    const ms = windowFor(at);
    if (ms !== null) setPending({ decision, at, ms });
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
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
    }, pending.ms);
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
        decideRef.current(k === 'a' ? 'approved' : 'rejected');
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
    const left = Math.max(0, Math.ceil((pending.at + pending.ms - now) / 1000));
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/50 px-3 py-2 text-sm"
        aria-live="polite"
      >
        <span>
          {pending.decision === 'approved' ? 'Approving' : 'Rejecting'} in{' '}
          <span className="tabular">{left}s</span>
          {note.trim() ? <span className="text-muted-foreground"> · with note</span> : null}
          {pending.ms < UNDO_MS ? (
            <span className="text-muted-foreground"> · shorter undo, the step times out soon</span>
          ) : null}
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

  if (windowFor(now) === null) {
    return (
      <p className="font-medium text-sm text-wait" role="status">
        Too late to decide here: the step is timing out
        {onTimeout ? ` and the order goes to ${onTimeout}` : ''}.
      </p>
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
        <Button size="sm" disabled={disabled} onClick={() => decide('approved')}>
          <Check /> Approve
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => decide('rejected')}>
          <X /> Reject
        </Button>
      </div>
    </div>
  );
}

/** A clock that ticks only while something on screen depends on it. */
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
