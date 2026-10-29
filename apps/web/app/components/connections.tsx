/**
 * Keyboard path for wiring a flow: each output of the selected node, what it connects to, and a
 * picker to connect it to another step. Mirrors what dragging between handles does on the canvas,
 * including the cycle check. Loop back-edges ("next") are still drawn on the canvas.
 */

import { type FlowGraph, type FlowNode, isBackEdge } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Item, ItemActions, ItemContent, ItemTitle } from '@orderloop/ui/item';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { Section } from '~/components/page';
import { useNodes } from '~/lib/nodes';
import { edgeId, wouldCycle } from './flow-canvas';

export function Connections({
  node,
  graph,
  onChange,
}: {
  node: FlowNode;
  graph: FlowGraph;
  onChange: (g: FlowGraph) => void;
}) {
  const nodes = useNodes();
  const outputs = nodes.outputs(node.type, nodes.withDefaults(node.type, node.config));
  const baseId = useId();
  const [picks, setPicks] = useState<Record<string, string>>({});
  if (!outputs.length) return null;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const forward = graph.edges.filter((e) => e.source === node.id && !isBackEdge(e));

  const connect = (output: string, target: string) => {
    const handle = output === 'out' ? null : output;
    const edge = { source: node.id, target, sourceHandle: handle, targetHandle: null };
    const id = edgeId(edge);
    if (graph.edges.some((e) => e.id === id)) return;
    onChange({ ...graph, edges: [...graph.edges, { id, ...edge }] });
  };
  const disconnect = (id: string, output: string) => {
    onChange({ ...graph, edges: graph.edges.filter((e) => e.id !== id) });
    // Keep keyboard focus in the same output instead of dropping it to the page.
    requestAnimationFrame(() => document.getElementById(`${baseId}-${output}`)?.focus());
  };

  return (
    <Section
      title="Connections"
      description="Where each output goes next. Same as dragging between dots on the canvas."
    >
      <ul className="flex flex-col gap-4">
        {outputs.map((o) => {
          const edges = forward.filter((e) => (e.sourceHandle || 'out') === o);
          const taken = new Set(edges.map((e) => e.target));
          const options = graph.nodes.filter(
            (n) =>
              n.id !== node.id &&
              !n.type.startsWith('trigger.') &&
              !taken.has(n.id) &&
              !wouldCycle(graph, node.id, n.id),
          );
          const selectId = `${baseId}-${o}`;
          return (
            <li key={o} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs">{o}</span>
                {!edges.length ? (
                  <span className="text-muted-foreground text-xs">Not connected</span>
                ) : null}
              </div>
              {edges.length ? (
                <ul className="flex flex-col gap-1">
                  {edges.map((e) => (
                    <Item
                      key={e.id}
                      asChild
                      variant="outline"
                      size="xs"
                      className="flex-nowrap py-1 pr-1"
                    >
                      <li>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="block w-full truncate font-normal">
                            {label(e.target)}
                          </ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => disconnect(e.id, o)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={`Disconnect ${o} from ${label(e.target)}`}
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </Button>
                        </ItemActions>
                      </li>
                    </Item>
                  ))}
                </ul>
              ) : null}
              {options.length ? (
                // Choosing is separate from connecting, so arrowing through the list is harmless.
                <Item size="xs" className="flex-nowrap gap-1.5 p-0">
                  <ItemContent className="min-w-0">
                    <label htmlFor={selectId} className="sr-only">
                      Connect {o} to
                    </label>
                    <NativeSelect
                      id={selectId}
                      value={picks[o] ?? ''}
                      onChange={(e) => setPicks((p) => ({ ...p, [o]: e.target.value }))}
                      className="h-8"
                      wrapperClassName="w-full"
                    >
                      <NativeSelectOption value="">Connect to…</NativeSelectOption>
                      {options.map((n) => (
                        <NativeSelectOption key={n.id} value={n.id}>
                          {n.label} ({n.id})
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!picks[o]}
                      onClick={() => {
                        connect(o, picks[o]!);
                        setPicks((p) => ({ ...p, [o]: '' }));
                      }}
                    >
                      Connect
                    </Button>
                  </ItemActions>
                </Item>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
