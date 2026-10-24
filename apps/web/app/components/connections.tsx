/**
 * Keyboard path for wiring a flow: each output of the selected node, what it connects to, and a
 * picker to connect it to another step. Mirrors what dragging between handles does on the canvas,
 * including the cycle check. Loop back-edges ("next") are still drawn on the canvas.
 */

import { type FlowGraph, type FlowNode, isBackEdge } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
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
  const [picks, setPicks] = useState<Record<string, string>>({});

  return (
    <div>
      <h2 className="section-title">Connections</h2>
      <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
        Where each output goes next. Same as dragging between dots on the canvas.
      </p>
      <ul className="space-y-3">
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
            <li key={o}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs">{o}</span>
                {!edges.length ? (
                  <span className="text-muted-foreground text-xs">Not connected</span>
                ) : null}
              </div>
              {edges.length ? (
                <ul className="mt-1 space-y-1">
                  {edges.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm"
                    >
                      <span className="min-w-0 truncate">{label(e.target)}</span>
                      <button
                        type="button"
                        onClick={() => disconnect(e.id, o)}
                        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`Disconnect ${o} from ${label(e.target)}`}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {options.length ? (
                <>
                  <label htmlFor={selectId} className="sr-only">
                    Connect {o} to
                  </label>
                  {/* Choosing is separate from connecting, so arrowing through the list is harmless. */}
                  <div className="mt-1 flex gap-1.5">
                    <select
                      id={selectId}
                      value={picks[o] ?? ''}
                      onChange={(e) => setPicks((p) => ({ ...p, [o]: e.target.value }))}
                      className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="">Connect to…</option>
                      {options.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.label} ({n.id})
                        </option>
                      ))}
                    </select>
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
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
