import { cn } from '@orderloop/ui/lib/utils';
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

function Stamp({ color, label, live }: { color: string; label: string; live?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-medium text-xs"
      style={{ color, background: `color-mix(in oklch, ${color} 11%, transparent)` }}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', live && 'motion-safe:animate-pulse')}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

/** Order or step status: a small tinted stamp in the status colour. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Stamp color={statusColor(status)} label={statusLabel(status)} live={status === 'running'} />
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
