import { cn } from '@orderloop/ui/lib/utils';
import { Undo2, X } from 'lucide-react';
import { outcomeLabel, statusColor, statusLabel } from '~/lib/format';

// Only running work pulses in badges and dots. A wait pulses once, on its step in the graph;
// pulsing it everywhere for days is noise.
export function StatusDot({ status, className }: { status?: string; className?: string }) {
  const live = status === 'running';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
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
  /** Ended badly: ruled in the colour with a mark, so it reads apart from a tinted wait. */
  ended?: 'failed' | 'undone';
}) {
  const Mark = ended === 'undone' ? Undo2 : X;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs',
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
          className={cn('size-1.5 rounded-full', live && 'motion-safe:animate-pulse')}
          style={{ background: color }}
        />
      )}
      {label}
    </span>
  );
}

const ENDED: Record<string, 'failed' | 'undone'> = {
  failed: 'failed',
  declined: 'failed',
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
