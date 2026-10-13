/**
 * Keyboard path for wiring a flow: each output of the selected node, what it connects to, and a
 * picker to connect it to another step. Mirrors what dragging between handles does on the canvas,
 * including the cycle check. Loop back-edges ("next") are still drawn on the canvas.
 */

import {
  type FlowGraph,
  type FlowNode,
  isBackEdge,
  nodeOutputs,
  withDefaults,
} from '@orderloop/core';
import { X } from 'lucide-react';
import { useId } from 'react';
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
  const outputs = nodeOutputs(node.type, withDefaults(node.type, node.config));
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
  const disconnect = (id: string) =>
    onChange({ ...graph, edges: graph.edges.filter((e) => e.id !== id) });

  return (
    <div>
      <h3 className="section-title">Connections</h3>
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
                        onClick={() => disconnect(e.id)}
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
                  <select
                    id={selectId}
                    value=""
                    onChange={(e) => e.target.value && connect(o, e.target.value)}
                    className="mt-1 h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm text-muted-foreground"
                  >
                    <option value="">Connect to…</option>
                    {options.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label} ({n.id})
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
