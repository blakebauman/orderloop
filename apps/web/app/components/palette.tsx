import { CATEGORY_LABELS, NODE_SPECS, type NodeCategory, type NodeSpec } from '@orderloop/core';
import { Input } from '@orderloop/ui/input';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@orderloop/ui/item';
import { useId, useState } from 'react';
import { useNodes } from '~/lib/nodes';
import { DRAG_TYPE } from './flow-canvas';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

/** Node palette: drag onto the canvas, or click (or press Enter) to add after the selection. */
export function Palette({ onPick }: { onPick: (type: string) => void }) {
  const [q, setQ] = useState('');
  const nodes = useNodes();
  const baseId = useId();
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
              <h2 className="caption mb-1.5 px-1">{title}</h2>
              <ul className="flex flex-col gap-0.5">
                {items.map((s) => {
                  const descId = `${baseId}-${s.type}`;
                  return (
                    <li key={s.type}>
                      <Item
                        asChild
                        size="xs"
                        // On a touch screen dragging is unreliable (iPadOS), so a tap adds it.
                        className="cursor-grab flex-nowrap items-start gap-2 px-2 py-1.5 text-left hover:border-border hover:bg-muted/60 active:cursor-grabbing touch:cursor-default touch:py-2.5"
                      >
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData(DRAG_TYPE, s.type);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onClick={() => onPick(s.type)}
                          title={s.description}
                          aria-label={s.label}
                          aria-describedby={descId}
                        >
                          <ItemMedia>
                            <NodeIcon
                              name={s.icon}
                              className="size-3.5 shrink-0"
                              style={{ color: CATEGORY_COLOR[s.category] }}
                            />
                          </ItemMedia>
                          <ItemContent className="min-w-0 gap-0">
                            <ItemTitle className="text-ui font-normal">{s.label}</ItemTitle>
                            <ItemDescription id={descId} className="line-clamp-1 text-xs">
                              {s.description}
                            </ItemDescription>
                          </ItemContent>
                        </button>
                      </Item>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
