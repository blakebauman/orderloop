import { cn } from '@orderloop/ui/lib/utils';
import { Ban, Undo2, X } from 'lucide-react';
import { outcomeLabel, statusColor, statusLabel } from '~/lib/format';

// Only running work pulses in badges and dots. A wait pulses once, on its step in the graph;
// pulsing it everywhere for days is noise.
export function StatusDot({ status, className }: { status?: string; className?: string }) {
  const live = status === 'running';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full transition-[background-color] duration-(--motion-move)',
        live && 'motion-safe:animate-pulse',
        className,
      )}
      style={{ background: statusColor(status) }}
    />
  );
}

function Stamp({
  color,
  label,
  live,
  ended,
}: {
  color: string;
  label: string;
  live?: boolean;
  /**
   * Ended other than completed: ruled in the colour with a mark, so it reads apart from a tinted
   * wait. Failed is an X, rolled back an undo arrow, declined a "no" sign: a decision, not a fault.
   */
  ended?: 'failed' | 'undone' | 'declined';
}) {
  const Mark = ended === 'undone' ? Undo2 : ended === 'declined' ? Ban : X;
  return (
    <span
      className={cn(
        // A step that changes state cross-fades to its new colour rather than snapping.
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs transition-[color,background-color,border-color] duration-(--motion-move)',
        ended && 'border py-px',
      )}
      style={
        ended
          ? { color, borderColor: color }
          : { color, background: `color-mix(in oklch, ${color} 11%, transparent)` }
      }
    >
      {ended ? (
        <Mark aria-hidden="true" className="size-3" strokeWidth={2.5} />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full transition-[background-color] duration-(--motion-move)',
            live && 'motion-safe:animate-pulse',
          )}
          style={{ background: color }}
        />
      )}
      {label}
    </span>
  );
}

const ENDED: Record<string, 'failed' | 'undone' | 'declined'> = {
  failed: 'failed',
  declined: 'declined',
  rolled_back: 'undone',
};

/** Order or step status: a small tinted stamp in the status colour; a bad ending is ruled. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Stamp
      color={statusColor(status)}
      label={statusLabel(status)}
      live={status === 'running'}
      ended={ENDED[status]}
    />
  );
}

export type Tone = 'ok' | 'wait' | 'bad' | 'undo' | 'idle' | 'run';

/**
 * A status from another vocabulary (a record's outcome, a cart, a promotion) in the status stamp,
 * by the token it means: a failure and a reversal are ruled, as an order's are.
 */
export function ToneBadge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Stamp
      color={`var(--${tone})`}
      label={label}
      ended={tone === 'bad' ? 'failed' : tone === 'undo' ? 'undone' : undefined}
    />
  );
}

const APPROVAL_COLOR: Record<string, string> = {
  pending: 'var(--wait)',
  approved: 'var(--ok)',
  rejected: 'var(--bad)',
  // Timed out: nobody decided. Neutral, so it doesn't read as a rejection or a rollback.
  escalated: 'var(--idle)',
};

/** Approval decisions have their own vocabulary; never borrow order statuses for them. */
export function ApprovalBadge({ status }: { status: string }) {
  return <Stamp color={APPROVAL_COLOR[status] ?? 'var(--idle)'} label={outcomeLabel(status)} />;
}
