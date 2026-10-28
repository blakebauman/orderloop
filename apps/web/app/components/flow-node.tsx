/**
 * A flow node card: a ledger entry on the sheet. A status rule on the left edge, the category icon,
 * undo/waits tags, the label, the last summary, and one labelled source handle per output branch.
 * Loop nodes get a second input ("next") on the bottom edge for back-edges: a hollow ink ring, named
 * on the card, since colour on the canvas is kept for status. Nothing on the card is set below 11px.
 */

import type { NodeCategory, NodeRun } from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { statusColor, statusLabel } from '~/lib/format';
import { useNodes } from '~/lib/nodes';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

export type FlowNodeData = {
  type: string;
  label: string;
  config: Record<string, unknown>;
  run?: NodeRun;
  /** Validation problem to flag on the card. */
  issue?: string;
  retries?: number;
};

export type FlowRfNode = Node<FlowNodeData, 'flow'>;

// A finger needs more than an 8px dot to start a connection: on touch the dot grows a little and
// carries an invisible 32px target around it.
const handleClass =
  "!size-2 !rounded-[2px] !border !border-[var(--node)] !bg-[var(--edge)] touch:!size-3 touch:after:absolute touch:after:-inset-2.5 touch:after:content-['']";

const CATEGORY_NAME: Record<NodeCategory, string> = {
  trigger: 'Trigger',
  commerce: 'Commerce',
  control: 'Control',
  ai: 'AI',
};

function FlowNodeCard({ id, data, selected, draggable }: NodeProps<FlowRfNode>) {
  const nodes = useNodes();
  const spec = nodes.spec(data.type);
  const category = (spec?.category ?? 'control') as NodeCategory;
  const outputs = nodes.outputs(data.type, data.config);
  const multi = outputs.length > 1 || (outputs.length === 1 && outputs[0] !== 'out');
  const status = data.run?.status;
  const started = status && status !== 'pending';
  // An End step "succeeds" at ending the order; what matters is the outcome it ended with.
  const outcome =
    data.type === 'control.end' && status === 'succeeded'
      ? String(data.config.outcome ?? 'completed')
      : undefined;
  // A wait that "succeeded" by timing out or being rejected is not good news; say what happened.
  const resolved =
    spec?.waits && status === 'succeeded'
      ? data.run?.branches?.find((b) => ['escalated', 'timeout', 'rejected'].includes(b))
      : undefined;
  const shown = outcome && outcome !== 'completed' ? outcome : status;
  const color = !started
    ? undefined
    : resolved === 'rejected'
      ? 'var(--bad)'
      : resolved
        ? 'var(--undo)'
        : statusColor(shown);
  const live = status === 'running' || status === 'waiting';
  const tags = [spec?.rollback ? 'undo' : null, spec?.waits ? 'waits' : null].filter(Boolean);

  return (
    <div
      className={cn(
        'relative w-[220px] rounded-md border bg-[var(--node)] text-left shadow-[0_1px_0_var(--rule)] transition-[border-color,box-shadow,opacity]',
        selected
          ? 'border-[var(--ink)] shadow-[0_0_0_2px_var(--ring)]'
          : 'border-[var(--node-border)]',
        data.issue && !selected && 'border-[var(--bad)]',
        status === 'skipped' && 'opacity-60',
      )}
    >
      {/* Status rule */}
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-[3px] rounded-l-md',
          live && 'motion-safe:animate-pulse',
        )}
        style={{ background: color ?? 'transparent' }}
      />
      {!data.type.startsWith('trigger.') ? (
        <Handle
          type="target"
          id="in"
          position={Position.Left}
          className={cn(handleClass, '!-left-1')}
        />
      ) : null}
      {spec?.loop ? (
        <Handle
          type="target"
          id="next"
          position={Position.Bottom}
          className={cn(
            handleClass,
            '!-bottom-1 !rounded-full !border-[1.5px] !border-[var(--ink)] !bg-[var(--node)]',
          )}
          title="next — connect the end of the loop body here"
        />
      ) : null}

      <div className="flex items-center gap-1.5 px-3 pt-2 text-2xs leading-4">
        <span
          style={{ color: CATEGORY_COLOR[category] }}
          className="flex items-center"
          title={CATEGORY_NAME[category]}
        >
          <NodeIcon name={spec?.icon ?? 'Play'} className="size-3.5" />
          <span className="sr-only">{CATEGORY_NAME[category]}</span>
        </span>
        {tags.length ? (
          <span className="text-[var(--muted-foreground)]">{tags.join(' · ')}</span>
        ) : null}
        {started ? (
          <span className="ml-auto font-medium" style={{ color }}>
            {outcome
              ? `Ended: ${statusLabel(outcome).toLowerCase()}`
              : resolved === 'rejected'
                ? 'Rejected'
                : resolved
                  ? 'Timed out'
                  : statusLabel(status)}
            {data.run && data.run.runs > 1 ? ` ×${data.run.runs}` : ''}
          </span>
        ) : null}
      </div>
      <div className="px-3 pt-0.5">
        <div className="truncate font-semibold text-ui text-[var(--ink)] leading-tight">
          {data.label}
        </div>
        <div className="truncate font-mono text-2xs text-[var(--muted-foreground)]">{id}</div>
      </div>

      {data.run?.summary || data.run?.error || data.issue ? (
        <div
          className={cn(
            'mx-3 mt-1.5 line-clamp-2 border-[var(--rule)] border-t border-dashed pt-1 text-[12px] text-[var(--muted-foreground)] leading-snug',
            (data.run?.error || data.issue) && 'text-[var(--bad)]',
          )}
          title={data.run?.error ?? data.issue ?? data.run?.summary}
        >
          {data.run?.error ?? data.issue ?? data.run?.summary}
        </div>
      ) : null}

      <div className={cn('pt-1.5 pb-2', multi && 'pt-1', spec?.loop && 'pb-0')}>
        {multi ? (
          outputs.map((o) => {
            const taken = data.run?.branches?.includes(o);
            return (
              <div key={o} className="relative flex h-5 items-center justify-end pr-3">
                <span
                  className={cn(
                    'flex items-center gap-1 font-mono text-2xs text-[var(--muted-foreground)]',
                    taken && 'font-semibold text-[var(--ink)]',
                  )}
                >
                  {taken ? (
                    <span className="size-1.5 rounded-full bg-[var(--ink)]" aria-hidden="true" />
                  ) : null}
                  {/* On a running order a timeout reads as one; the editor keeps the output's name. */}
                  {!draggable && o === 'escalated' ? 'timed out' : o}
                  {taken ? <span className="sr-only"> (taken)</span> : null}
                </span>
                <Handle
                  type="source"
                  id={o}
                  position={Position.Right}
                  className={cn(handleClass, '!-right-1', taken && '!bg-[var(--ink)]')}
                />
              </div>
            );
          })
        ) : outputs.length ? (
          <Handle
            type="source"
            id="out"
            position={Position.Right}
            className={cn(handleClass, '!-right-1')}
          />
        ) : null}
      </div>
      {spec?.loop ? (
        <div className="pt-0.5 pb-2 text-center font-mono text-2xs text-[var(--muted-foreground)] leading-none">
          next
        </div>
      ) : null}
    </div>
  );
}

export const FlowNodeView = memo(FlowNodeCard);
