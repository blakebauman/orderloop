/**
 * Graph validation and the planner the Workflow interpreter drives.
 *
 * The planner is a pure state machine over node and edge states, so its semantics are unit tested
 * here and the Workflow only adds durability:
 * - A node is ready once every forward input edge is resolved and at least one is active
 *   (an AND-join that tolerates untaken branches). If every input is inactive the node is skipped,
 *   and skipping propagates downstream.
 * - Completing a node activates the out-edges for the branches it chose and deactivates the rest.
 * - Back-edges (targetHandle "next") point into a `control.loop` node. Activating one makes the loop
 *   pending again; continuing the loop resets its body region for the next iteration.
 */

import { nodeOutputs, nodeSpec, validateConfig } from './catalog';
import type { FlowEdge, FlowGraph, FlowNode, NodeStatus } from './types';

export const LOOP_INPUT = 'next';
export const DEFAULT_OUTPUT = 'out';

export type EdgeState = 'pending' | 'active' | 'inactive';

export type PlanNode = {
  status: NodeStatus;
  /** How many times the node has started; part of its durable step name. */
  runs: number;
  branches?: string[];
};

export type PlanState = {
  nodes: Record<string, PlanNode>;
  edges: Record<string, EdgeState>;
};

export const isBackEdge = (e: Pick<FlowEdge, 'targetHandle'>) => e.targetHandle === LOOP_INPUT;
export const edgeHandle = (e: Pick<FlowEdge, 'sourceHandle'>) => e.sourceHandle || DEFAULT_OUTPUT;

export function isTrigger(n: Pick<FlowNode, 'type'>) {
  return n.type.startsWith('trigger.');
}

export function initPlan(graph: FlowGraph): PlanState {
  return {
    nodes: Object.fromEntries(graph.nodes.map((n) => [n.id, { status: 'pending', runs: 0 }])),
    edges: Object.fromEntries(graph.edges.map((e) => [e.id, 'pending'])),
  };
}

function index(graph: FlowGraph) {
  const inputs = new Map<string, FlowEdge[]>();
  const outputs = new Map<string, FlowEdge[]>();
  for (const n of graph.nodes) {
    inputs.set(n.id, []);
    outputs.set(n.id, []);
  }
  for (const e of graph.edges) {
    inputs.get(e.target)?.push(e);
    outputs.get(e.source)?.push(e);
  }
  return { inputs, outputs };
}

/**
 * Resolve skips to a fixpoint and return the nodes that can start now, in graph order.
 * Mutates `state` (skipped nodes and their out-edges).
 */
export function readyNodes(
  graph: FlowGraph,
  state: PlanState,
): { ready: string[]; skipped: string[] } {
  const { inputs, outputs } = index(graph);
  const skipped: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      const ns = state.nodes[n.id]!;
      if (ns.status !== 'pending') continue;
      const ins = inputs.get(n.id)!;
      const forward = ins.filter((e) => !isBackEdge(e));
      if (ins.some((e) => isBackEdge(e) && state.edges[e.id] === 'active')) continue;
      if (forward.length === 0) continue;
      const resolved = forward.every((e) => state.edges[e.id] !== 'pending');
      if (resolved && forward.every((e) => state.edges[e.id] === 'inactive')) {
        ns.status = 'skipped';
        skipped.push(n.id);
        for (const e of outputs.get(n.id)!) state.edges[e.id] = 'inactive';
        changed = true;
      }
    }
  }

  const ready: string[] = [];
  for (const n of graph.nodes) {
    const ns = state.nodes[n.id]!;
    if (ns.status !== 'pending') continue;
    const ins = inputs.get(n.id)!;
    const forward = ins.filter((e) => !isBackEdge(e));
    const reentered = ins.some((e) => isBackEdge(e) && state.edges[e.id] === 'active');
    if (reentered) ready.push(n.id);
    else if (forward.length === 0) {
      if (ns.runs === 0) ready.push(n.id);
    } else if (
      forward.every((e) => state.edges[e.id] !== 'pending') &&
      forward.some((e) => state.edges[e.id] === 'active')
    ) {
      ready.push(n.id);
    }
  }
  return { ready, skipped };
}

/** Mark a node started; returns its deterministic step key for this run. */
export function beginNode(state: PlanState, nodeId: string): string {
  const ns = state.nodes[nodeId]!;
  ns.runs += 1;
  ns.status = 'running';
  return `${nodeId}#${ns.runs}`;
}

/** Complete a node with the branches it chose ("out" for single-output nodes). */
export function completeNode(
  graph: FlowGraph,
  state: PlanState,
  nodeId: string,
  branches: string[] = [DEFAULT_OUTPUT],
): void {
  const ns = state.nodes[nodeId]!;
  ns.status = 'succeeded';
  ns.branches = branches;
  // Consumed: a loop's back-edges reset once the loop has run.
  for (const e of graph.edges) {
    if (e.target === nodeId && isBackEdge(e)) state.edges[e.id] = 'pending';
  }
  for (const e of graph.edges) {
    if (e.source !== nodeId) continue;
    const active = branches.includes(edgeHandle(e));
    state.edges[e.id] = active ? 'active' : 'inactive';
    if (active && isBackEdge(e)) state.nodes[e.target]!.status = 'pending';
  }
}

/** Nodes reachable from a loop's "body" output without passing back through the loop. */
export function loopRegion(graph: FlowGraph, loopId: string): Set<string> {
  const { outputs } = index(graph);
  const region = new Set<string>();
  const stack = (outputs.get(loopId) ?? [])
    .filter((e) => edgeHandle(e) === 'body')
    .map((e) => e.target);
  while (stack.length) {
    const id = stack.pop()!;
    if (id === loopId || region.has(id)) continue;
    region.add(id);
    for (const e of outputs.get(id) ?? []) if (!isBackEdge(e)) stack.push(e.target);
  }
  return region;
}

/**
 * Complete a loop node. Continuing resets the body region (statuses and edges) so it runs again;
 * run counts are kept so the next iteration's step names are new.
 */
export function completeLoop(
  graph: FlowGraph,
  state: PlanState,
  loopId: string,
  next: boolean,
): void {
  if (next) {
    const region = loopRegion(graph, loopId);
    for (const id of region) state.nodes[id]!.status = 'pending';
    for (const e of graph.edges) {
      if (region.has(e.source)) state.edges[e.id] = 'pending';
    }
  }
  completeNode(graph, state, loopId, [next ? 'body' : 'done']);
  // Iterating doesn't decide the exit yet: leave "done" pending so what follows the loop isn't
  // skipped before the final iteration.
  if (next) {
    for (const e of graph.edges) {
      if (e.source === loopId && edgeHandle(e) === 'done') state.edges[e.id] = 'pending';
    }
  }
}

export function isSettled(graph: FlowGraph, state: PlanState): boolean {
  if (Object.values(state.nodes).some((n) => n.status === 'running' || n.status === 'waiting')) {
    return false;
  }
  return readyNodes(graph, structuredClone(state)).ready.length === 0;
}

// ── Validation ──────────────────────────────────────────────────────────────

export type GraphIssue = { nodeId?: string; edgeId?: string; message: string };

export function validateGraph(graph: FlowGraph): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const ids = new Set<string>();
  const byId = new Map<string, FlowNode>();

  for (const n of graph.nodes) {
    if (ids.has(n.id)) errors.push({ nodeId: n.id, message: `Duplicate node id “${n.id}”` });
    ids.add(n.id);
    byId.set(n.id, n);
    if (!nodeSpec(n.type)) {
      errors.push({ nodeId: n.id, message: `Unknown node type “${n.type}”` });
      continue;
    }
    for (const m of validateConfig(n.type, n.config)) {
      errors.push({ nodeId: n.id, message: `${n.label}: ${m}` });
    }
  }

  const triggers = graph.nodes.filter(isTrigger);
  if (triggers.length !== 1) {
    errors.push({ message: `A flow needs exactly one trigger (found ${triggers.length})` });
  }

  const edgeKeys = new Set<string>();
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) {
      errors.push({ edgeId: e.id, message: 'Edge points at a missing node' });
      continue;
    }
    const key = `${e.source}:${edgeHandle(e)}→${e.target}:${e.targetHandle ?? ''}`;
    if (edgeKeys.has(key)) warnings.push({ edgeId: e.id, message: 'Duplicate edge' });
    edgeKeys.add(key);
    if (nodeSpec(s.type) && !nodeOutputs(s.type, s.config).includes(edgeHandle(e))) {
      errors.push({
        edgeId: e.id,
        nodeId: s.id,
        message: `${s.label} has no “${edgeHandle(e)}” output`,
      });
    }
    if (isBackEdge(e) && !nodeSpec(t.type)?.loop) {
      errors.push({ edgeId: e.id, message: 'Only a Loop node accepts a “next” edge' });
    }
    if (isTrigger(t)) errors.push({ edgeId: e.id, message: 'Triggers cannot have inputs' });
  }

  // Forward edges must form a DAG.
  const forward = graph.edges.filter(
    (e) => !isBackEdge(e) && ids.has(e.source) && ids.has(e.target),
  );
  const indeg = new Map([...ids].map((id) => [id, 0]));
  for (const e of forward) indeg.set(e.target, indeg.get(e.target)! + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const e of forward) {
      if (e.source !== id) continue;
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (seen < ids.size) {
    errors.push({
      message: 'The flow has a cycle. Use a Loop node with a “next” edge to repeat steps.',
    });
  }

  for (const n of graph.nodes) {
    if (isTrigger(n)) continue;
    if (!forward.some((e) => e.target === n.id)) {
      errors.push({ nodeId: n.id, message: `${n.label} is not connected to anything upstream` });
    }
    const outs = nodeSpec(n.type) ? nodeOutputs(n.type, n.config) : [];
    if (outs.length && !graph.edges.some((e) => e.source === n.id)) {
      warnings.push({
        nodeId: n.id,
        message: `${n.label} has no outgoing edge; the run ends there`,
      });
    }
  }

  for (const e of graph.edges.filter(isBackEdge)) {
    if (byId.get(e.target) && !loopRegion(graph, e.target).has(e.source)) {
      errors.push({
        edgeId: e.id,
        message: 'A “next” edge must come from inside that loop’s body',
      });
    }
  }

  return { errors, warnings };
}

/** A key that changes only when topology changes (used to decide when to re-layout). */
export function topologyKey(graph: FlowGraph): string {
  return [
    graph.nodes
      .map((n) => n.id)
      .sort()
      .join(','),
    graph.edges
      .map((e) => `${e.source}>${e.target}`)
      .sort()
      .join(','),
  ].join('|');
}
