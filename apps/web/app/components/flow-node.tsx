/**
 * A flow node card: a ledger entry on the sheet. A status rule on the left edge, a mono category
 * tag, the label, the last summary line, and one labelled source handle per output branch. Loop
 * nodes get a second input ("next") on the bottom edge for back-edges.
 */

import { type NodeCategory, type NodeRun, nodeOutputs, nodeSpec } from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { statusColor, statusLabel } from '~/lib/format';
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

const handleClass = '!size-2 !rounded-[2px] !border !border-[var(--node)] !bg-[var(--edge)]';

const CATEGORY_TAG: Record<NodeCategory, string> = {
  trigger: 'TRIGGER',
  commerce: 'COMMERCE',
  control: 'CONTROL',
  ai: 'AI',
};

function FlowNodeCard({ id, data, selected }: NodeProps<FlowRfNode>) {
  const spec = nodeSpec(data.type);
  const category = (spec?.category ?? 'control') as NodeCategory;
  const outputs = nodeOutputs(data.type, data.config);
  const multi = outputs.length > 1 || (outputs.length === 1 && outputs[0] !== 'out');
  const status = data.run?.status;
  const started = status && status !== 'pending';
  const color = started ? statusColor(status) : undefined;
  const live = status === 'running' || status === 'waiting';
  const tags = [spec?.rollback ? 'undo' : null, spec?.waits ? 'waits' : null].filter(Boolean);

  return (
    <div
      className={cn(
        'relative w-[210px] rounded-md border bg-[var(--node)] text-left shadow-[0_1px_0_var(--rule)] transition-[border-color,box-shadow,opacity]',
        selected
          ? 'border-[var(--ink)] shadow-[0_0_0_2px_var(--ring)]'
          : 'border-[var(--node-border)]',
        data.issue && !selected && 'border-[var(--bad)]',
        status === 'skipped' && 'opacity-40',
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
          className={cn(handleClass, '!-bottom-1 !bg-[var(--wait)]')}
          title="next — connect the end of the loop body here"
        />
      ) : null}

      <div className="flex items-center gap-1.5 px-3 pt-2">
        <span style={{ color: CATEGORY_COLOR[category] }} className="flex items-center gap-1">
          <NodeIcon name={spec?.icon ?? 'Play'} className="size-3" />
          <span className="font-mono font-semibold text-[9.5px] tracking-wider">
            {CATEGORY_TAG[category]}
          </span>
        </span>
        {tags.map((t) => (
          <span
            key={t}
            className="font-mono text-[9.5px] text-[var(--muted-foreground)] tracking-wider"
          >
            · {t}
          </span>
        ))}
        {started ? (
          <span
            className="ml-auto font-mono font-semibold text-[9.5px] uppercase tracking-wider"
            style={{ color }}
          >
            {statusLabel(status)}
            {data.run && data.run.runs > 1 ? ` ×${data.run.runs}` : ''}
          </span>
        ) : null}
      </div>
      <div className="px-3 pt-0.5">
        <div className="truncate font-semibold text-[13px] text-[var(--ink)] leading-tight">
          {data.label}
        </div>
        <div className="truncate font-mono text-[10px] text-[var(--muted-foreground)]">{id}</div>
      </div>

      {data.run?.summary || data.run?.error || data.issue ? (
        <div
          className={cn(
            'mx-3 mt-1.5 truncate border-[var(--rule)] border-t border-dashed pt-1 font-mono text-[10.5px] text-[var(--muted-foreground)]',
            (data.run?.error || data.issue) && 'text-[var(--bad)]',
          )}
          title={data.run?.error ?? data.issue ?? data.run?.summary}
        >
          {data.run?.error ?? data.issue ?? data.run?.summary}
        </div>
      ) : null}

      <div className={cn('pt-1.5 pb-2', multi && 'pt-1')}>
        {multi ? (
          outputs.map((o) => {
            const taken = data.run?.branches?.includes(o);
            return (
              <div key={o} className="relative flex h-[18px] items-center justify-end pr-3">
                <span
                  className={cn(
                    'font-mono text-[10px] text-[var(--muted-foreground)]',
                    taken && 'font-semibold text-[var(--primary)]',
                  )}
                >
                  {taken ? '● ' : ''}
                  {o}
                </span>
                <Handle
                  type="source"
                  id={o}
                  position={Position.Right}
                  className={cn(handleClass, '!-right-1', taken && '!bg-[var(--primary)]')}
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
    </div>
  );
}

export const FlowNodeView = memo(FlowNodeCard);
