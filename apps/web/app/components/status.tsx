import { cn } from '@orderloop/ui/lib/utils';
import { statusColor, statusLabel } from '~/lib/format';

export function StatusDot({ status, className }: { status?: string; className?: string }) {
  const live = status === 'running' || status === 'waiting';
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        live && 'motion-safe:animate-pulse',
        className,
      )}
      style={{ background: statusColor(status) }}
    />
  );
}

/** Status as a ledger stamp: mono caps in the status colour on a faint tint. */
export function StatusBadge({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono font-semibold text-[10.5px] uppercase tracking-wider"
      style={{ color, background: `color-mix(in oklch, ${color} 12%, transparent)` }}
    >
      <StatusDot status={status} className="size-1.5" />
      {statusLabel(status)}
    </span>
  );
}
