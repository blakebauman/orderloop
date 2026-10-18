/**
 * Pure helpers for starting an order by hand: the lines grammar, and what a published flow will
 * ask of people. Shared by the new-order form (live preview) and its action (the real check).
 */

import { type FlowGraph, isTrigger, nodeSpec, type OrderLine } from '@orderloop/core';

export type LineIssue = { line: string; problem: string };

const SKU = /[A-Z]{2,4}-\d{2,4}/i;

/**
 * One line per row: "WID-100 x 50", "50 x WID-100", "50 WID-100" or "WID-100, 50"; no number
 * means one. A row without a SKU, with a quantity of zero or less, or with more than one number
 * comes back as an issue rather than a guess. With `known`, a SKU outside it is an issue too.
 */
export function parseLines(
  text: string,
  known?: ReadonlySet<string>,
): { lines: OrderLine[]; issues: LineIssue[] } {
  const lines: OrderLine[] = [];
  const issues: LineIssue[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = SKU.exec(line);
    if (!match) {
      issues.push({ line, problem: 'no SKU' });
      continue;
    }
    const sku = match[0].toUpperCase();
    const rest = `${line.slice(0, match.index)} ${line.slice(match.index + match[0].length)}`;
    const numbers = rest.match(/-?\d+(?:\.\d+)?/g) ?? [];
    if (numbers.length > 1) {
      issues.push({ line, problem: 'more than one number' });
      continue;
    }
    const qty = numbers.length ? Number(numbers[0]) : 1;
    if (!(qty > 0)) issues.push({ line, problem: 'quantity must be above zero' });
    else if (known && !known.has(sku))
      issues.push({ line, problem: `${sku} is not in the catalog` });
    else lines.push({ sku, qty });
  }
  return { lines, issues };
}

/** "“x” (no SKU)", joined, for an inline message. */
export const describeIssues = (issues: LineIssue[]) =>
  issues.map((i) => `“${i.line}” (${i.problem})`).join(', ');

/** Adds one of `sku`, or one more to the row that already orders it. */
export function addOne(text: string, sku: string): string {
  const rows = text.split('\n');
  const at = rows.findIndex((row) => {
    const { lines, issues } = parseLines(row);
    return !issues.length && lines[0]?.sku === sku;
  });
  if (at >= 0) {
    const qty = parseLines(rows[at] ?? '').lines[0]?.qty ?? 0;
    rows[at] = `${sku} x ${qty + 1}`;
    return rows.join('\n');
  }
  return `${text.trim() ? `${text.trimEnd()}\n` : ''}${sku} x 1`;
}

export type FlowSummary = {
  /** Steps that do work: everything but triggers and ends. */
  steps: number;
  /** Where a person decides. */
  approvals: string[];
  /** Business events the order waits for. */
  waits: string[];
  /** Steps undone if the order fails after them. */
  rollbacks: string[];
  /** Has an AI extract step, so the inbound document matters. */
  readsDocument: boolean;
  /** Has a fulfillment routing step, so the method and store matter. */
  routesFulfillment: boolean;
};

export function summarizeFlow(graph: FlowGraph): FlowSummary {
  const labels = (pick: (type: string) => boolean) => [
    ...new Set(
      graph.nodes
        .filter((n) => pick(n.type))
        .map((n) => n.label || nodeSpec(n.type)?.label || n.type),
    ),
  ];
  const has = (type: string) => graph.nodes.some((n) => n.type === type);
  return {
    steps: graph.nodes.filter((n) => !isTrigger(n) && n.type !== 'control.end').length,
    approvals: labels((t) => t === 'control.approval'),
    waits: labels((t) => t === 'control.wait_event'),
    rollbacks: labels((t) => !!nodeSpec(t)?.rollback),
    readsDocument: has('ai.extract'),
    routesFulfillment: has('commerce.route_fulfillment'),
  };
}
