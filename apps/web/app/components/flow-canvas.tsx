/**
 * The flow canvas. The parent owns the graph JSON; this renders it
 * with React Flow and reports edits back as a new graph. Used read-only on the order page, where
 * node runs and edge states colour the graph live.
 */

import {
  autoLayout,
  type EdgeState,
  type FlowEdge,
  type FlowGraph,
  isBackEdge,
  type NodeRun,
  nodeSpec,
  topologyKey,
  withDefaults,
} from '@orderloop/core';
import { cn } from '@orderloop/ui/lib/utils';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MarkerType,
  MiniMap,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { LayoutGrid, Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { statusColor } from '~/lib/format';
import { FlowNodeView, type FlowRfNode } from './flow-node';

const nodeTypes = { flow: FlowNodeView };

export const DRAG_TYPE = 'application/orderloop-node';

const surface =
  'relative h-full min-h-[360px] w-full overflow-hidden rounded-md border bg-[var(--sheet)]';

const toolbarButton =
  'inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 font-medium text-muted-foreground text-xs transition hover:bg-muted hover:text-foreground';

export type FlowCanvasProps = {
  graph: FlowGraph;
  editable?: boolean;
  runs?: Record<string, NodeRun>;
  edgeStates?: Record<string, EdgeState>;
  issues?: Record<string, string>;
  selectedId?: string | null;
  onChange?: (g: FlowGraph) => void;
  onSelect?: (id: string | null) => void;
  /** Called when a palette item is dropped on the canvas. */
  onAddNode?: (type: string, position: { x: number; y: number }) => void;
  className?: string;
};

export function FlowCanvas(props: FlowCanvasProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className={cn(surface, props.className)} />;
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

function edgeId(c: {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}) {
  return `${c.source}${c.sourceHandle && c.sourceHandle !== 'out' ? `.${c.sourceHandle}` : ''}-${c.target}${c.targetHandle === 'next' ? '.next' : ''}`;
}

/** Would adding source→target close a forward cycle? */
function wouldCycle(graph: FlowGraph, source: string, target: string) {
  if (source === target) return true;
  const out = new Map<string, string[]>();
  for (const e of graph.edges)
    if (!isBackEdge(e)) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out.get(id) ?? []));
  }
  return false;
}

function Inner({
  graph,
  editable = false,
  runs,
  edgeStates,
  issues,
  selectedId,
  onChange,
  onSelect,
  onAddNode,
  className,
}: FlowCanvasProps) {
  const { fitView, screenToFlowPosition } = useReactFlow();
  const [expanded, setExpanded] = useState(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const fromProps: FlowRfNode[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'flow',
        position: n.position,
        selected: n.id === selectedId,
        draggable: editable,
        ariaLabel: `${n.label}, ${runs?.[n.id]?.status ?? 'not started'}`,
        data: {
          type: n.type,
          label: n.label,
          config: n.config,
          run: runs?.[n.id],
          issue: issues?.[n.id],
          retries: n.retries,
        },
      })),
    [graph.nodes, runs, issues, selectedId, editable],
  );

  // React Flow keeps measurements (and hides nodes until they exist) on its node objects, so hold
  // them in local state and merge each prop update in rather than replacing them.
  const [nodes, setNodes] = useState<FlowRfNode[]>(fromProps);
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return fromProps.map((n) => {
        const o = old.get(n.id);
        return o ? { ...o, ...n, measured: o.measured, width: o.width, height: o.height } : n;
      });
    });
  }, [fromProps]);

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const state = edgeStates?.[e.id];
        const back = isBackEdge(e);
        const targetRun = runs?.[e.target];
        const live =
          state === 'active' &&
          (targetRun?.status === 'running' || targetRun?.status === 'waiting');
        const stroke =
          state === 'active'
            ? 'var(--edge-active)'
            : state === 'inactive'
              ? 'var(--edge-idle)'
              : back
                ? 'var(--wait)'
                : 'var(--edge)';
        const handle = e.sourceHandle && e.sourceHandle !== 'out' ? e.sourceHandle : undefined;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle || 'out',
          targetHandle: e.targetHandle || 'in',
          type: back ? 'default' : 'smoothstep',
          label: back ? 'next' : undefined,
          className: live ? 'ol-edge-live' : undefined,
          style: {
            stroke,
            strokeWidth: state === 'active' ? 2 : 1.25,
            strokeDasharray: back || state === 'inactive' ? '5 4' : undefined,
            opacity: state === 'inactive' ? 0.5 : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
          data: { handle },
        };
      }),
    [graph.edges, edgeStates, runs],
  );

  // Fit when the graph first appears and whenever its shape changes (template load, copilot).
  const topo = topologyKey(graph);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit on topology only
  useEffect(() => {
    const t = window.setTimeout(() => {
      // Wide flows would shrink to illegible; keep a readable floor and show the start, or the
      // step the order is on now.
      const g = graphRef.current;
      const live = g.nodes.filter((n) =>
        ['running', 'waiting'].includes(runs?.[n.id]?.status ?? ''),
      );
      // No live step: frame the first few columns from the trigger, so the flow reads left to right.
      const start = g.nodes.find((n) => n.type.startsWith('trigger.'));
      const focus = live.length
        ? live
        : start
          ? g.nodes.filter((n) => n.position.x <= start.position.x + 3 * 280)
          : [];
      void fitView({
        padding: 0.12,
        minZoom: 0.7,
        maxZoom: 1,
        nodes: focus.length && g.nodes.length > 10 ? focus.map((n) => ({ id: n.id })) : undefined,
      });
    }, 30);
    return () => window.clearTimeout(t);
  }, [topo, fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowRfNode>[]) => {
      for (const c of changes) {
        if (c.type === 'select' && c.selected) onSelect?.(c.id);
      }
      setNodes((prev) => applyNodeChanges(changes, prev));
      if (!editable || !onChange) return;
      const relevant = changes.filter((c) => c.type === 'position' || c.type === 'remove');
      if (!relevant.length) return;
      const g = graphRef.current;
      const next = applyNodeChanges(relevant, nodes);
      const ids = new Set(next.map((n) => n.id));
      const pos = new Map(next.map((n) => [n.id, n.position]));
      onChange({
        nodes: g.nodes
          .filter((n) => ids.has(n.id))
          .map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })),
        edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      });
      if (relevant.some((c) => c.type === 'remove')) onSelect?.(null);
    },
    [editable, onChange, onSelect, nodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!editable || !onChange) return;
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
      if (!removed.size) return;
      const g = graphRef.current;
      onChange({ ...g, edges: g.edges.filter((e) => !removed.has(e.id)) });
    },
    [editable, onChange],
  );

  const isValidConnection = useCallback((c: Connection | Edge) => {
    const g = graphRef.current;
    if (!c.source || !c.target) return false;
    if (c.targetHandle === 'next') return c.source !== c.target;
    return !wouldCycle(g, c.source, c.target);
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!onChange) return;
      const g = graphRef.current;
      const edge: FlowEdge = {
        id: edgeId(c),
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle && c.sourceHandle !== 'out' ? c.sourceHandle : null,
        targetHandle: c.targetHandle === 'next' ? 'next' : null,
      };
      if (g.edges.some((e) => e.id === edge.id)) return;
      onChange({ ...g, edges: [...g.edges, edge] });
    },
    [onChange],
  );

  const onDrop = useCallback(
    (ev: React.DragEvent) => {
      const type = ev.dataTransfer.getData(DRAG_TYPE);
      if (!type || !onAddNode) return;
      ev.preventDefault();
      onAddNode(type, screenToFlowPosition({ x: ev.clientX - 115, y: ev.clientY - 30 }));
    },
    [onAddNode, screenToFlowPosition],
  );

  const tidy = () => {
    if (!onChange) return;
    onChange(autoLayout(graphRef.current));
  };

  return (
    <div className={cn(surface, expanded && 'fixed inset-3 z-50 h-auto', className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onPaneClick={() => onSelect?.(null)}
        onDrop={onDrop}
        onDragOver={(e) => {
          if (onAddNode) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        minZoom={0.2}
        maxZoom={1.6}
        colorMode="system"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="var(--sheet-grid)"
        />
        <Controls showInteractive={false} position="bottom-left" />
        {graph.nodes.length > 10 ? (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            style={{ width: 150, height: 100 }}
            maskColor="color-mix(in oklch, var(--paper) 70%, transparent)"
            nodeColor={(n) => statusColor((n.data as { run?: NodeRun }).run?.status)}
          />
        ) : null}
        <Panel position="top-right" className="flex gap-1.5">
          {editable ? (
            <button type="button" className={toolbarButton} onClick={tidy} title="Re-layout">
              <LayoutGrid className="size-3.5" /> Tidy
            </button>
          ) : null}
          <button
            type="button"
            className={toolbarButton}
            onClick={() => setExpanded((v) => !v)}
            title="Expand (F)"
          >
            {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </Panel>
        {graph.nodes.length === 0 ? (
          <Panel position="top-center" className="mt-24 text-center text-muted-foreground text-sm">
            Drag a trigger from the palette to start, or ask the copilot to draft a flow.
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}

/** A new node of `type` with defaults and a unique id. */
export function makeNode(graph: FlowGraph, type: string, position: { x: number; y: number }) {
  const spec = nodeSpec(type);
  const base = type.split('.')[1] ?? 'node';
  let i = 1;
  while (graph.nodes.some((n) => n.id === `${base}_${i}`)) i++;
  return {
    id: `${base}_${i}`,
    type,
    label: spec?.label ?? type,
    config: withDefaults(type),
    position,
  };
}
