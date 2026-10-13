/**
 * Expressions over the run context. Conditions are JSON Logic (data, not code: safe to store and
 * to accept from the copilot); text fields interpolate `{{path.to.value}}`.
 */

import jsonLogic from 'json-logic-js';
import type { Order } from './types';

/** What every expression and template sees while a flow runs. */
export type RunContext = {
  order: Order;
  /** Output of each node that has run, by node id (latest iteration). */
  nodes: Record<string, unknown>;
  vars: Record<string, unknown>;
  /** The payload of the trigger. */
  input: Record<string, unknown>;
  now: number;
};

jsonLogic.add_operation('now', () => Date.now());
jsonLogic.add_operation('days', (n: number) => n * 86_400_000);
jsonLogic.add_operation('len', (v: unknown) =>
  Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : 0,
);

export function evaluate(expression: unknown, ctx: RunContext): unknown {
  if (expression === undefined || expression === null) return expression;
  if (typeof expression !== 'object') return expression;
  return jsonLogic.apply(expression as jsonLogic.RulesLogic, ctx);
}

export function truthy(expression: unknown, ctx: RunContext): boolean {
  return jsonLogic.truthy(evaluate(expression, ctx));
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function interpolate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getPath(ctx, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Money with two decimals; avoids float drift accumulating across lines. */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}
