import { CATEGORY_LABELS, NODE_SPECS, type NodeCategory } from '@orderloop/core';
import { Input } from '@orderloop/ui/input';
import { useState } from 'react';
import { DRAG_TYPE } from './flow-canvas';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

/** Node palette: drag onto the canvas, or click (or press Enter) to add after the selection. */
export function Palette({ onPick }: { onPick: (type: string) => void }) {
  const [q, setQ] = useState('');
  const needle = q.toLowerCase();
  const cats = Object.keys(CATEGORY_LABELS) as NodeCategory[];
  return (
    <div className="flex h-full flex-col">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search nodes"
        aria-label="Search nodes"
        className="h-8 text-sm"
      />
      <div className="mt-3 flex-1 space-y-4 overflow-y-auto pr-1">
        {cats.map((cat) => {
          const items = NODE_SPECS.filter(
            (s) =>
              s.category === cat &&
              (!needle || `${s.label} ${s.description} ${s.type}`.toLowerCase().includes(needle)),
          );
          if (!items.length) return null;
          return (
            <section key={cat}>
              <h2 className="caption mb-1.5">{CATEGORY_LABELS[cat]}</h2>
              <div className="space-y-1">
                {items.map((s) => (
                  <button
                    key={s.type}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, s.type);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={() => onPick(s.type)}
                    title={s.description}
                    className="flex w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-[13px] hover:border-border hover:bg-muted/60 active:cursor-grabbing"
                  >
                    <NodeIcon
                      name={s.icon}
                      className="size-3.5 shrink-0"
                      style={{ color: CATEGORY_COLOR[cat] }}
                    />
                    <span className="truncate">{s.label}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
