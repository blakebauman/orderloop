/**
 * The storefront flow as the page draws it: the published template from @orderloop/core, levelled
 * by the planner's own layout functions, then set as ledger lines (a few levels to a line, wrapping
 * like text) so a nineteen-level graph reads at a size a person can read.
 */
import {
  type FlowEdge,
  type FlowNode,
  levelsOf,
  nodeSpec,
  orderLevels,
  storefrontOrderFlow,
} from '@orderloop/core';

export const flow = storefrontOrderFlow();

const byId = new Map(flow.nodes.map((n) => [n.id, n]));
export const node = (id: string): FlowNode => {
  const n = byId.get(id);
  if (!n) throw new Error(`tpl-storefront-order has no node "${id}"`);
  return n;
};

const handle = (e: FlowEdge) => e.sourceHandle ?? 'out';

/** The branch each decision takes in the run the page tells. Anything unnamed takes `out`. */
export type Choices = Record<string, string>;

/** Follows the graph from its trigger, taking the chosen branch at each step. */
export function runPath(choices: Choices): string[] {
  const start = flow.nodes.find((n) => n.type.startsWith('trigger.'));
  if (!start) throw new Error('tpl-storefront-order has no trigger');
  const path = [start.id];
  for (let at = start.id; ; ) {
    const out = flow.edges.filter((e) => e.source === at);
    const next = out.find((e) => handle(e) === (choices[at] ?? 'out')) ?? out[0];
    if (!next) return path;
    if (path.includes(next.target)) throw new Error(`loop at ${next.target}`);
    path.push(next.target);
    at = next.target;
  }
}

/** The hero's run: everything goes right, then the customer sends part of it back. */
export const HERO_CHOICES: Choices = {
  shipping: 'ok',
  policy: 'pass',
  authorize: 'ok',
  reserve: 'ok',
  capture: 'ok',
  window: 'received',
  back: 'received',
  refund: 'ok',
};

export type PlateNode = {
  id: string;
  label: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Position on the run, or -1 for a branch this run didn't take. */
  step: number;
  category: string;
  rollback: boolean;
  waits: boolean;
  outcome?: string;
};

export type PlateEdge = { d: string; step: number };

export type Plate = { width: number; height: number; nodes: PlateNode[]; edges: PlateEdge[] };

/** Splits a label onto two lines when it won't fit the node. */
function wrap(label: string, max: number): string[] {
  if (label.length <= max) return [label];
  const words = label.split(' ');
  let first = '';
  while (words.length && `${first} ${words[0]}`.trim().length <= max) {
    first = `${first} ${words.shift()}`.trim();
  }
  return first ? [first, words.join(' ')] : [label];
}

/**
 * Sets the flow as ledger lines of `perLine` levels inside `width` units. The run's node sits on
 * each column's first row; branches it didn't take hang below it, smaller and ghosted. An edge that
 * crosses a line break returns along the right margin like a carriage return.
 */
export function plate(choices: Choices, perLine: number, width: number): Plate {
  const path = runPath(choices);
  const columns = orderLevels(flow, levelsOf(flow)).map((col) =>
    [...col].sort((a, b) => Number(!path.includes(a)) - Number(!path.includes(b))),
  );
  const PAD = 16;
  const RETURN = 22;
  const MAIN_H = 52;
  const GHOST_H = 34;
  const GHOST_GAP = 10;
  const LINE_GAP = 46;
  const colW = (width - PAD - RETURN) / perLine;
  const nodeW = colW - 30;

  const nodes: PlateNode[] = [];
  const at = new Map<string, PlateNode>();
  let y = PAD;
  const lineOf = new Map<string, number>();
  const lineTop: number[] = [];
  for (let start = 0, line = 0; start < columns.length; start += perLine, line++) {
    const cols = columns.slice(start, start + perLine);
    const depth = Math.max(...cols.map((c) => c.length));
    lineTop.push(y);
    cols.forEach((col, i) => {
      col.forEach((id, row) => {
        const n = node(id);
        const spec = nodeSpec(n.type);
        const main = row === 0 && path.includes(id);
        const h = main ? MAIN_H : GHOST_H;
        const p: PlateNode = {
          id,
          label: wrap(n.label, main ? 17 : 19),
          x: PAD + i * colW,
          y: row === 0 ? y : y + MAIN_H + GHOST_GAP + (row - 1) * (GHOST_H + GHOST_GAP),
          w: nodeW,
          h,
          step: path.indexOf(id),
          category: spec?.category ?? 'control',
          rollback: !!spec?.rollback,
          waits: !!spec?.waits,
          outcome: n.type === 'control.end' ? String(n.config.outcome ?? '') : undefined,
        };
        nodes.push(p);
        at.set(id, p);
        lineOf.set(id, line);
      });
    });
    y += MAIN_H + (depth - 1) * (GHOST_H + GHOST_GAP) + LINE_GAP;
  }

  const right = width - RETURN / 2;
  const edges: PlateEdge[] = flow.edges.flatMap((e) => {
    const s = at.get(e.source);
    const t = at.get(e.target);
    if (!s || !t) return [];
    const sx = s.x + s.w;
    const sy = s.y + s.h / 2;
    const tx = t.x;
    const ty = t.y + t.h / 2;
    let d: string;
    if (lineOf.get(e.source) === lineOf.get(e.target)) {
      const mx = (sx + tx) / 2;
      d = `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
    } else {
      // Out to the margin, down into the gap above the target's line, back to the left edge.
      const gap = lineTop[lineOf.get(e.target)!]! - LINE_GAP / 2;
      const r = 8;
      d =
        `M${sx},${sy} H${right - r} Q${right},${sy} ${right},${sy + r} V${gap - r} ` +
        `Q${right},${gap} ${right - r},${gap} H${PAD / 2 + r} Q${PAD / 2},${gap} ${PAD / 2},${gap + r} ` +
        `V${ty - r} Q${PAD / 2},${ty} ${PAD / 2 + r},${ty} H${tx}`;
    }
    const taken = s.step >= 0 && t.step === s.step + 1;
    return [{ d, step: taken ? s.step : -1 }];
  });

  return { width, height: y - LINE_GAP + PAD, nodes, edges };
}

/** Counts for the plate's caption, read off the template rather than typed in. */
export const FLOW_FACTS = {
  nodes: flow.nodes.length,
  edges: flow.edges.length,
  outcomes: flow.nodes.filter((n) => n.type === 'control.end').length,
  levels: orderLevels(flow, levelsOf(flow)).length,
};
