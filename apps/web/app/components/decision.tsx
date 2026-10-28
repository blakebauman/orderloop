/**
 * Approve / reject with a note and a short undo window. Nothing is sent until the window closes, so
 * "Undo" is real: the order's Workflow never hears about a decision that was taken back.
 * Shared by the approvals inbox and the order page; each passes its own transport.
 */

import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { Check, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type ApprovalContext, deadlineWords, lockAt, SEND_MS, WARN_MS } from '~/lib/approvals';
import { until } from '~/lib/format';
import { useDateTime } from '~/lib/use-date-time';
import { useNow } from '~/lib/use-now';

const UNDO_MS = 5000;

export type Decision = 'approved' | 'rejected';

/**
 * What a list can ask of one row's controls: a batch decides each selected row through its own
 * controls, so every decision in it gets that row's undo window, note and refusals.
 */
export type DecisionHandle = {
  /**
   * Holds `decision` as if its button were pressed. `quiet` leaves focus and the announcement to the
   * batch. Returns when its undo window ends, or null if nothing was held (closed, busy, already held).
   */
  decide: (decision: Decision, opts?: { quiet?: boolean }) => number | null;
  /** Takes back a held decision; nothing is sent. */
  undo: () => void;
};

const noSubscribe = () => () => {};

/**
 * The deadline, said first: "Decide in 3m", "Closes 2:05 PM", "Decisions close in 8s". Muted while
 * there is time and ink in the last ten seconds; never amber, which is for overdue ages. The full
 * time is in the tooltip.
 */
export function DecisionDeadline({
  deadline,
  onTimeout,
  className,
}: {
  deadline: number;
  /** Where the order goes if nobody decides, for the closed line. */
  onTimeout?: string;
  className?: string;
}) {
  const now = useNow(1000);
  const formatTime = useDateTime();
  // The server can't know the viewer's zone: it and the hydrating render say UTC, then local.
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const w = deadlineWords(deadline, now, hydrated ? undefined : 'UTC');
  return (
    <span
      className={cn(
        'tabular',
        w.kind === 'soon' ? 'font-medium text-foreground' : 'text-muted-foreground',
        className,
      )}
      title={formatTime(deadline)}
      suppressHydrationWarning
    >
      {w.kind === 'closed'
        ? `Decisions closed${onTimeout ? `; it goes to ${onTimeout}` : ''}`
        : w.kind === 'soon'
          ? `Decisions close ${w.when}`
          : w.kind === 'in'
            ? `Decide ${w.when}`
            : `Closes ${w.when}`}
    </span>
  );
}

/**
 * Why a person is asked, the figures behind it, what the order is for, the approvals before this
 * one, and the escalation clock.
 */
export function DecisionContext({
  ctx,
  className,
  clock = true,
  reason = true,
}: {
  ctx: ApprovalContext;
  className?: string;
  /** Show the escalation clock; off once the approval is no longer open. */
  clock?: boolean;
  /** Show the reason line; off where the row already says it. */
  reason?: boolean;
}) {
  const now = useNow(clock && ctx.deadline ? 1000 : null);
  const formatTime = useDateTime();
  const ticking = clock && ctx.deadline !== undefined && lockAt(ctx.deadline) > now;
  const said = reason ? ctx.reason : undefined;
  if (!said && !ctx.facts.length && !ctx.lines && !ctx.trail.length && !ticking) return null;
  return (
    <div className={cn('space-y-0.5 text-sm', className)}>
      {said ? <p className="font-medium text-foreground">{said}</p> : null}
      {ctx.facts.length ? (
        <p className="max-w-[72ch] text-muted-foreground text-xs tabular">
          {ctx.facts.join(' · ')}
        </p>
      ) : null}
      {ctx.lines ? (
        <p className="max-w-[72ch] truncate text-muted-foreground text-xs" title={ctx.lines}>
          For {ctx.lines}
        </p>
      ) : null}
      {ctx.trail.length ? (
        <p className="max-w-[72ch] text-muted-foreground text-xs">
          Before this: {ctx.trail.join(', then ')}
        </p>
      ) : null}
      {/* The clock counts to when decisions close, the moment that matters to the person deciding;
          once closed, the controls say what happens next. A deadline still ahead is muted: amber
          is for one that has passed. */}
      {ticking && ctx.deadline ? (
        <p
          className="text-muted-foreground text-xs"
          title={formatTime(ctx.deadline)}
          suppressHydrationWarning
        >
          {lockAt(ctx.deadline) - now <= WARN_MS
            ? `Decisions close ${until(lockAt(ctx.deadline), now)}${ctx.onTimeout ? `, then it goes to ${ctx.onTimeout}` : ''}`
            : ctx.onTimeout
              ? `If no one decides ${until(lockAt(ctx.deadline), now)}, it goes to ${ctx.onTimeout}`
              : `Times out ${until(lockAt(ctx.deadline), now)}`}
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
  label,
  defaultNote = '',
  withNote = true,
  handle,
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
  /** What the buttons decide, for their accessible names, e.g. "#agszfp, $9,760.00". */
  label?: string;
  defaultNote?: string;
  /** Show the note field. Hidden, a note already typed is kept and still sent. */
  withNote?: boolean;
  /** For a list that decides several rows at once (`DecisionHandle`). */
  handle?: React.Ref<DecisionHandle>;
}) {
  const [note, setNote] = useState(defaultNote);
  // `ms` is this decision's undo window: shorter than usual when the step is about to time out.
  // A quiet one was made by a batch, which takes focus and speaks for all of its rows.
  const [pending, setPending] = useState<{
    decision: Decision;
    at: number;
    ms: number;
    quiet?: boolean;
  } | null>(null);
  // Near the deadline, tick so the controls lock before a decision could arrive too late.
  const nearDeadline = deadline !== undefined && deadline - Date.now() < UNDO_MS + 60_000;
  const now = useNow(pending ? 250 : nearDeadline ? 1000 : null);
  /** The undo window a decision made at `at` gets, or null once decisions have closed. */
  const windowFor = (at: number) => {
    if (deadline === undefined) return UNDO_MS;
    if (at > lockAt(deadline)) return null;
    return Math.min(UNDO_MS, deadline - at - SEND_MS);
  };
  const locked = deadline !== undefined && now > lockAt(deadline);
  const warning = deadline !== undefined && !locked && lockAt(deadline) - now <= WARN_MS;
  const rootRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef<HTMLParagraphElement>(null);
  // When decisions close under someone's focus, hand it to the message that says why. Track focus
  // ourselves: the browser drops it from a control the moment that control is disabled.
  const focusWithin = useRef(false);
  useEffect(() => {
    // Focus moving anywhere fires focusin; focus dropped because a control was disabled doesn't,
    // so the last place it went still tells us whether it was in this card.
    const onIn = (e: FocusEvent) => {
      focusWithin.current = !!rootRef.current?.contains(e.target as Node);
    };
    document.addEventListener('focusin', onIn);
    return () => document.removeEventListener('focusin', onIn);
  }, []);
  useEffect(() => {
    if (locked && focusWithin.current) closedRef.current?.focus();
  }, [locked]);
  const decide = (decision: Decision, quiet?: boolean) => {
    const at = Date.now();
    const ms = windowFor(at);
    if (ms !== null) setPending({ decision, at, ms, quiet });
    return ms === null ? null : at + ms;
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const held = useRef(false);
  held.current = !!pending;
  useImperativeHandle(
    handle,
    () => ({
      decide: (decision, opts) =>
        held.current || busy || disabled ? null : decideRef.current(decision, opts?.quiet),
      undo: () => setPending(null),
    }),
    [busy, disabled],
  );
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
      // A row's selection checkbox is still the row; a text field is not.
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox';
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
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
      <p className="animate-arrive text-muted-foreground text-sm" aria-live="polite">
        Recording decision…
      </p>
    );
  }

  if (pending) {
    const left = Math.max(0, Math.ceil((pending.at + pending.ms - now) / 1000));
    return (
      <div
        className="relative flex animate-arrive flex-wrap items-center gap-3 overflow-hidden rounded-lg border bg-muted/50 px-3 py-2 text-sm"
        aria-live={pending.quiet ? undefined : 'polite'}
      >
        {/* The window running out, drained over exactly this decision's window (shorter near a
            deadline). Hidden where motion is reduced: the seconds say the same. */}
        <span
          key={pending.at}
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-foreground/35 motion-reduce:hidden"
          style={{ animation: `ol-drain ${pending.ms}ms linear forwards` }}
        />
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
          autoFocus={!pending.quiet}
        >
          Undo
        </Button>
      </div>
    );
  }

  // Closed decisions keep the controls (and any note) in place, disabled, under one line that
  // says what happens next, in ink: amber is for overdue ages. Ten seconds before, screen readers
  // hear it once. (The inbox moves a closed row out of its queue instead.)
  return (
    <div ref={rootRef} className="space-y-2">
      {locked ? (
        <p
          ref={closedRef}
          tabIndex={-1}
          role="status"
          className="font-medium text-foreground text-sm outline-none"
        >
          Decisions are closed;{' '}
          {onTimeout ? `the order is going to ${onTimeout}` : 'the step is timing out'}.
        </p>
      ) : (
        <span className="sr-only" aria-live="polite">
          {warning ? 'Ten seconds left to decide.' : ''}
        </span>
      )}
      <DecisionForm
        compact={compact}
        noteId={noteId}
        note={note}
        setNote={setNote}
        disabled={disabled || locked}
        decide={decide}
        label={label}
        withNote={withNote}
      />
    </div>
  );
}

function DecisionForm({
  compact,
  noteId,
  note,
  setNote,
  disabled,
  decide,
  label,
  withNote,
}: {
  compact?: boolean;
  noteId: string;
  note: string;
  setNote: (note: string) => void;
  disabled?: boolean;
  decide: (decision: Decision) => void;
  label?: string;
  withNote?: boolean;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', compact && 'sm:flex-nowrap')}>
      {withNote ? (
        <>
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
        </>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => decide('approved')}
          aria-label={label ? `Approve ${label}` : undefined}
          aria-keyshortcuts="A"
        >
          <Check aria-hidden="true" /> Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => decide('rejected')}
          aria-label={label ? `Reject ${label}` : undefined}
          aria-keyshortcuts="R"
        >
          <X aria-hidden="true" /> Reject
        </Button>
      </div>
    </div>
  );
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
