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
  type NodeRegistry,
  type NodeRun,
  topologyKey,
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
  type Rect,
  useReactFlow,
} from '@xyflow/react';
// Only the pages with a canvas load React Flow's stylesheet; app.css restyles it for Ledger.
import '@xyflow/react/dist/style.css';
import { Crosshair, LayoutGrid, Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMedia } from '~/lib/device';
import { statusColor } from '~/lib/format';
import { pageShortcut } from '~/lib/shortcuts';
import { useTheme } from '~/lib/theme';
import { FlowNodeView, type FlowRfNode } from './flow-node';

const nodeTypes = { flow: FlowNodeView };

export const DRAG_TYPE = 'application/orderloop-node';

const surface =
  'relative h-full min-h-[360px] w-full overflow-hidden rounded-md border bg-[var(--sheet)]';

const toolbarButton =
  'hit-area inline-flex items-center gap-1.5 card px-2.5 py-1 font-medium text-muted-foreground text-xs transition hover:bg-muted hover:text-foreground';

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

export function edgeId(c: {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}) {
  return `${c.source}${c.sourceHandle && c.sourceHandle !== 'out' ? `.${c.sourceHandle}` : ''}-${c.target}${c.targetHandle === 'next' ? '.next' : ''}`;
}

/** Would adding source→target close a forward cycle? */
export function wouldCycle(graph: FlowGraph, source: string, target: string) {
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

/** Whether a node from new props shows exactly what the node on the canvas already shows. */
function sameNode(a: FlowRfNode, b: FlowRfNode) {
  return (
    a.selected === b.selected &&
    a.draggable === b.draggable &&
    a.ariaLabel === b.ariaLabel &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    JSON.stringify(a.data) === JSON.stringify(b.data)
  );
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
  const { screenToFlowPosition, setViewport, getNodesBounds, getNodes } = useReactFlow();
  const { resolved: colorMode } = useTheme();
  const touch = useMedia('(pointer: coarse)');
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
        if (!o) return n;
        // Live updates arrive as fresh objects for every step; keep the old node when nothing it
        // shows changed, so the memoised card for an untouched step doesn't render again.
        if (sameNode(o, n)) return o;
        return { ...o, ...n, measured: o.measured, width: o.width, height: o.height };
      });
    });
  }, [fromProps]);

  // On a running order a step grows as its results arrive (a summary, the branch it took). The
  // flow's positions assume the empty card, so once sizes are measured, move each step clear of a
  // taller one above it in its column. Display only; the flow keeps its positions.
  const heightKey = nodes.map((n) => `${n.id}:${Math.round(n.measured?.height ?? 0)}`).join(',');
  useEffect(() => {
    if (editable) return;
    setNodes((prev) => {
      const heights = new Map(prev.map((n) => [n.id, n.measured?.height]));
      if ([...heights.values()].some((h) => !h)) return prev;
      const placed = spreadColumns(graphRef.current.nodes, heights as Map<string, number>);
      const moved = prev.some((n) => placed.get(n.id)?.y !== n.position.y);
      return moved ? prev.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position })) : prev;
    });
  }, [heightKey, editable, fromProps]);

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

  const liveIds = graph.nodes
    .filter((n) => ['running', 'waiting'].includes(runs?.[n.id]?.status ?? ''))
    .map((n) => n.id);
  const liveKey = liveIds.join(',');
  const liveKeyRef = useRef(liveKey);
  liveKeyRef.current = liveKey;
  const runsRef = useRef(runs);
  runsRef.current = runs;

  const wrapRef = useRef<HTMLDivElement>(null);
  /**
   * Frame the whole flow when it fits at a readable zoom; otherwise the live step(s), or where a
   * finished run stopped or ended, or with none of those the first few columns from the trigger.
   */
  const frame = useCallback(
    (animate = false) => {
      const g = graphRef.current;
      const live = liveKeyRef.current ? liveKeyRef.current.split(',') : [];
      // A finished run that went wrong is framed where it stopped.
      const stopped = g.nodes
        .filter((n) => ['failed', 'rolled_back'].includes(runsRef.current?.[n.id]?.status ?? ''))
        .map((n) => n.id);
      // A finished run is framed where it ended.
      const ended = g.nodes
        .filter(
          (n) =>
            n.type.startsWith('control.end') && runsRef.current?.[n.id]?.status === 'succeeded',
        )
        .map((n) => n.id);
      const start = g.nodes.find((n) => n.type.startsWith('trigger.'));
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = animate && !reduce ? 300 : 0;
      const el = wrapRef.current;
      const w = el?.clientWidth ?? 0;
      const h = el?.clientHeight ?? 0;
      const all = getNodesBounds(g.nodes.map((n) => n.id));
      if (!w || !h || !all.width) return;
      const fits = (b: Rect) =>
        Math.min((w - 2 * FRAME_PAD) / b.width, (h - 2 * FRAME_PAD) / b.height);
      const middle = (b: Rect, zoom: number) => h / 2 - (b.y + b.height / 2) * zoom;
      // The whole flow fits at a readable zoom: show all of it, centred.
      if (fits(all) >= MIN_READABLE_ZOOM) {
        const zoom = Math.min(1, fits(all));
        void setViewport(
          { x: w / 2 - (all.x + all.width / 2) * zoom, y: middle(all, zoom), zoom },
          { duration },
        );
        return;
      }
      const firstColumns = start
        ? g.nodes.filter((n) => n.position.x <= start.position.x + 3 * 280).map((n) => n.id)
        : [];
      const focus = live.length ? live : stopped.length ? stopped : ended.length ? ended : [];
      const spans = getNodes().map((n) => ({
        left: n.position.x,
        right: n.position.x + (n.measured?.width ?? n.width ?? 0),
      }));
      // Nothing to follow: open on the trigger and what comes after it, anchored at the left edge,
      // zoomed out a little if that ends the frame between columns rather than through a step.
      if (!focus.length && firstColumns.length) {
        const b = getNodesBounds(firstColumns);
        const zoom = clearRightEdge(spans, b.x, clampZoom(fits(b)), w);
        void setViewport({ x: FRAME_PAD - b.x * zoom, y: middle(b, zoom), zoom }, { duration });
        return;
      }
      // Otherwise centre the focus and the steps either side of it, then move the frame so no step
      // is cut in half at the left edge: a sliver of a card reads as a broken layout.
      const ids = focus.length ? withNeighbours(g, focus) : g.nodes.map((n) => n.id);
      const b = getNodesBounds(ids);
      const zoom = clampZoom(fits(b));
      let x = w / 2 - (b.x + b.width / 2) * zoom;
      const boxes = spans.map((n) => ({ left: n.left * zoom, right: n.right * zoom }));
      const cut = boxes.filter((n) => x + n.left < 0 && x + n.right > 0);
      if (cut.length) {
        const kept = getNodesBounds(focus.length ? focus : ids);
        const inShift = FRAME_PAD - Math.min(...cut.map((n) => x + n.left));
        // Bring the cut step fully in while the focus still fits; otherwise push it fully out.
        x +=
          x + inShift + (kept.x + kept.width) * zoom <= w - FRAME_PAD
            ? inShift
            : -Math.max(...cut.map((n) => x + n.right));
      }
      void setViewport({ x, y: middle(b, zoom), zoom }, { duration });
    },
    [setViewport, getNodesBounds, getNodes],
  );
  // The sheet settles its size after the first frame (panels load, a phone stacks the layout,
  // the canvas expands). Until someone pans or zooms, keep the framing true to the new size.
  const handled = useRef(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      setNarrow(el.clientWidth < 480);
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (!handled.current) frame();
      }, 60);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [frame]);

  // Fit when the graph first appears and whenever its shape changes (template load, copilot).
  const topo = topologyKey(graph);
  // Refit on topology only.
  useEffect(() => {
    const t = window.setTimeout(() => frame(), 30);
    return () => window.clearTimeout(t);
  }, [topo, frame]);

  // Follow the run: when a different step becomes live, bring it into view.
  const firstLive = useRef(true);
  useEffect(() => {
    if (firstLive.current) {
      firstLive.current = false;
      return;
    }
    if (!liveKey || editable) return;
    const t = window.setTimeout(() => frame(true), 60);
    return () => window.clearTimeout(t);
  }, [liveKey, editable, frame]);

  // F toggles the expanded view, Escape leaves it. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        if (pageShortcut(e)) setExpanded((v) => !v);
      } else if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    <div
      ref={wrapRef}
      className={cn(
        surface,
        // Expanded, it fills the screen inside the notch, the status bar and the home indicator.
        expanded &&
          'fixed top-[max(0.75rem,var(--safe-top))] right-[max(0.75rem,var(--safe-right))] bottom-[max(0.75rem,var(--safe-bottom))] left-[max(0.75rem,var(--safe-left))] z-50 h-auto w-auto',
        className,
      )}
    >
      <ReactFlow
        nodes={nodes}
        onMoveStart={(e) => {
          // Only a person's pan or zoom carries an event; programmatic framing doesn't.
          if (e) handled.current = true;
        }}
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
        // A connection dropped near an input snaps to it; a fingertip lands less precisely.
        connectionRadius={touch ? 40 : 20}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        minZoom={0.2}
        maxZoom={1.6}
        colorMode={colorMode}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color="var(--sheet-grid)"
        />
        <Controls showInteractive={false} position="bottom-left" />
        {/* On a narrow sheet the map would cover the steps it summarises. */}
        {graph.nodes.length > 10 && !narrow ? (
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
          {!editable && liveIds.length ? (
            <button
              type="button"
              className={toolbarButton}
              onClick={() => {
                handled.current = false;
                frame(true);
              }}
            >
              <Crosshair className="size-3.5" aria-hidden="true" /> Live step
            </button>
          ) : null}
          {editable ? (
            <button type="button" className={toolbarButton} onClick={tidy}>
              <LayoutGrid className="size-3.5" aria-hidden="true" /> Tidy layout
            </button>
          ) : null}
          <button
            type="button"
            className={toolbarButton}
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Collapse canvas (Esc)' : 'Expand canvas (F)'}
            title={expanded ? 'Collapse (Esc)' : 'Expand (F)'}
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
export function makeNode(
  nodes: NodeRegistry,
  graph: FlowGraph,
  type: string,
  position: { x: number; y: number },
) {
  const spec = nodes.spec(type);
  const base = type.split('.')[1] ?? 'node';
  let i = 1;
  while (graph.nodes.some((n) => n.id === `${base}_${i}`)) i++;
  return {
    id: `${base}_${i}`,
    type,
    label: spec?.label ?? type,
    config: nodes.withDefaults(type),
    position,
  };
}

/** Steps are 220px wide; a step overlaps another in its column when their x is closer than that. */
const NODE_WIDTH = 220;
const NODE_GAP = 16;

/** Space kept between a framed flow and the sheet's edge, in screen pixels. */
const FRAME_PAD = 24;
/** Wide flows would shrink to illegible; framing never goes below this zoom. */
const MIN_READABLE_ZOOM = 0.7;
const clampZoom = (z: number) => Math.min(1, Math.max(MIN_READABLE_ZOOM, z));

/**
 * The largest zoom, no more than `zoom` and still readable, at which a frame anchored at `originX`
 * (flow units, drawn at FRAME_PAD) ends between columns instead of through a step. `zoom` itself
 * when no such zoom exists.
 */
export function clearRightEdge(
  spans: { left: number; right: number }[],
  originX: number,
  zoom: number,
  width: number,
) {
  const room = width - 2 * FRAME_PAD;
  const clear = (z: number) =>
    spans.every((n) => {
      const left = (n.left - originX) * z;
      const right = (n.right - originX) * z;
      return right <= room + 0.5 || left >= room + FRAME_PAD;
    });
  if (clear(zoom)) return zoom;
  const candidates = spans
    .filter((n) => n.right > originX)
    .map((n) => room / (n.right - originX))
    .filter((z) => z < zoom && z >= MIN_READABLE_ZOOM)
    .sort((a, b) => b - a);
  return candidates.find(clear) ?? zoom;
}

/** Each step's position, moved down below any step above it in its column that it would overlap. */
function spreadColumns(
  steps: { id: string; position: { x: number; y: number } }[],
  heights: Map<string, number>,
) {
  const placed = new Map(steps.map((n) => [n.id, { ...n.position }]));
  const order = [...steps].sort((a, b) => a.position.y - b.position.y).map((n) => n.id);
  for (let i = 0; i < order.length; i++) {
    const me = placed.get(order[i]!)!;
    for (let j = 0; j < i; j++) {
      const above = placed.get(order[j]!)!;
      const bottom = above.y + (heights.get(order[j]!) ?? 0) + NODE_GAP;
      if (Math.abs(above.x - me.x) < NODE_WIDTH && above.y <= me.y && bottom > me.y) me.y = bottom;
    }
  }
  return placed;
}

/** The focus steps plus what leads into and out of them, so a framed step keeps its context. */
function withNeighbours(g: FlowGraph, ids: string[]) {
  const set = new Set(ids);
  for (const e of g.edges) {
    if (isBackEdge(e)) continue;
    if (ids.includes(e.target)) set.add(e.source);
    if (ids.includes(e.source)) set.add(e.target);
  }
  return [...set];
}
