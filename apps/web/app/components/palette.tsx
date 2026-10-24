import { CATEGORY_LABELS, NODE_SPECS, type NodeCategory, type NodeSpec } from '@orderloop/core';
import { Input } from '@orderloop/ui/input';
import { useState } from 'react';
import { useNodes } from '~/lib/nodes';
import { DRAG_TYPE } from './flow-canvas';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

/** Node palette: drag onto the canvas, or click (or press Enter) to add after the selection. */
export function Palette({ onPick }: { onPick: (type: string) => void }) {
  const [q, setQ] = useState('');
  const nodes = useNodes();
  const needle = q.toLowerCase();
  const cats = Object.keys(CATEGORY_LABELS) as NodeCategory[];
  const matches = (s: NodeSpec) =>
    !needle || `${s.label} ${s.description} ${s.type}`.toLowerCase().includes(needle);
  // Built-in nodes by category, then each installed plugin's nodes under its name.
  const plugins = new Map<string, { title: string; items: NodeSpec[] }>();
  for (const { plugin, spec } of nodes.pluginNodes()) {
    const group = plugins.get(plugin.id) ?? { title: plugin.name, items: [] };
    if (matches(spec)) group.items.push(spec);
    plugins.set(plugin.id, group);
  }
  const sections = [
    ...cats.map((cat) => ({
      key: cat,
      title: CATEGORY_LABELS[cat],
      items: NODE_SPECS.filter((s) => s.category === cat && matches(s)) as NodeSpec[],
    })),
    ...[...plugins].map(([id, g]) => ({ key: `plugin:${id}`, ...g })),
  ];
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
        {sections.map(({ key, title, items }) => {
          if (!items.length) return null;
          return (
            <section key={key}>
              <h2 className="caption mb-1.5">{title}</h2>
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
                      style={{ color: CATEGORY_COLOR[s.category] }}
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
