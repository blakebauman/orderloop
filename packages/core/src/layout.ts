/**
 * Layered left-to-right layout (ported from durablefibers' dag-layout): levels by longest path
 * over forward edges, then two barycentre sweeps to reduce crossings. Used for templates, copilot
 * output and the editor's "Tidy" action. Loop back-edges are ignored for layering.
 */

import { isBackEdge } from './graph';
import type { FlowGraph } from './types';

export const COL_WIDTH = 280;
export const ROW_HEIGHT = 150;
export const ORIGIN_X = 56;
export const ORIGIN_Y = 48;

export function levelsOf(graph: FlowGraph): Map<string, number> {
  const parents = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (!isBackEdge(e) && parents.has(e.target) && parents.has(e.source)) {
      parents.get(e.target)!.push(e.source);
    }
  }
  const levels = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ps = parents.get(id) ?? [];
    const lvl = ps.length ? Math.max(...ps.map((p) => visit(p, seen) + 1)) : 0;
    seen.delete(id);
    levels.set(id, lvl);
    return lvl;
  };
  for (const n of graph.nodes) visit(n.id, new Set());
  return levels;
}

export function orderLevels(graph: FlowGraph, levels: Map<string, number>): string[][] {
  const maxLevel = Math.max(0, ...levels.values());
  const columns: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const n of graph.nodes) columns[levels.get(n.id) ?? 0]!.push(n.id);

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (isBackEdge(e)) continue;
    parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }
  const rowOf = (col: string[]) => new Map(col.map((id, i) => [id, i]));
  const sortBy = (col: string[], key: Map<string, number>) =>
    [...col].sort((a, b) => {
      const ka = key.get(a);
      const kb = key.get(b);
      if (ka === undefined && kb === undefined) return 0;
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      return ka - kb;
    });
  const sweep = (l: number, adj: string[], rel: Map<string, string[]>) => {
    const pos = rowOf(adj);
    const key = new Map<string, number>();
    for (const id of columns[l]!) {
      const xs = (rel.get(id) ?? []).map((p) => pos.get(p)).filter((v) => v !== undefined);
      if (xs.length) key.set(id, xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    columns[l] = sortBy(columns[l]!, key);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < columns.length; l++) sweep(l, columns[l - 1]!, parents);
    for (let l = columns.length - 2; l >= 0; l--) sweep(l, columns[l + 1]!, children);
  }
  return columns;
}

/** Returns a copy of the graph with every node positioned. Columns are centred vertically. */
export function autoLayout<G extends FlowGraph>(graph: G): G {
  const columns = orderLevels(graph, levelsOf(graph));
  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, l) => {
    const offset = ((tallest - col.length) * ROW_HEIGHT) / 2;
    col.forEach((id, r) => {
      pos.set(id, { x: ORIGIN_X + l * COL_WIDTH, y: ORIGIN_Y + offset + r * ROW_HEIGHT });
    });
  });
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })),
  };
}
