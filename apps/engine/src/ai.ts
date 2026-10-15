/**
 * Workers AI calls. Every call uses JSON mode against a schema and has a deterministic heuristic
 * fallback, used when AI_MODE is "mock" (tests, offline dev) or the model errors, so an order never
 * stalls on the model. Results record which path produced them.
 */

import {
  autoLayout,
  type CopilotRequest,
  type CopilotResult,
  conforms,
  type FlowGraph,
  flowGraphSchema,
  isBuySide,
  NODE_SPECS,
  nodeOutputs,
  ORDER_MODEL_LABELS,
  type Order,
  type OrderLine,
  validateGraph,
  withDefaults,
} from '@orderloop/core';

export type AiSource = 'model' | 'heuristic';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

/** A slow model must not hold an order step (or the editor) hostage; fall back instead. */
const AI_TIMEOUT_MS = 20_000;

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`AI call timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runJson<T>(
  env: Env,
  messages: Msg[],
  schema: Record<string, unknown>,
  fallback: () => T,
): Promise<{ value: T; source: AiSource }> {
  if (String(env.AI_MODE) === 'mock') return { value: fallback(), source: 'heuristic' };
  try {
    const res = (await withTimeout(
      env.AI.run(
        env.AI_MODEL as keyof AiModels,
        {
          messages,
          response_format: { type: 'json_schema', json_schema: schema },
          max_tokens: 2048,
          temperature: 0.2,
        } as never,
        env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
      ),
      AI_TIMEOUT_MS,
    )) as { response?: unknown };
    const raw = res.response;
    const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
    if (value === undefined || value === null) throw new Error('empty response');
    // A malformed answer would fail the step and call the model again on every retry.
    if (!conforms(value, schema)) throw new Error('response does not match the schema');
    return { value, source: 'model' };
  } catch (err) {
    console.warn('ai fallback', err instanceof Error ? err.message : err);
    return { value: fallback(), source: 'heuristic' };
  }
}

/** The parts of an order a model needs, without internal bookkeeping. */
export const orderBrief = (order: Order) => ({
  id: order.id,
  model: order.model,
  channel: order.channel,
  customerId: order.customerId,
  title: order.title,
  lines: order.lines,
  subtotal: order.subtotal,
  shipping: order.shipping ?? 0,
  shippingOption: order.shippingOption,
  tax: order.tax,
  total: order.total,
  currency: order.currency,
  meta: order.meta,
});

const brief = (order: Order) => JSON.stringify(orderBrief(order));

// ── Extract ────────────────────────────────────────────────────────────────

export type Extracted = {
  customerName: string | null;
  poNumber: string | null;
  lines: OrderLine[];
  notes: string | null;
};

const LINE_RE = /\b(\d{1,6})\s*(?:x|×|pcs|units?|ea)?\s*(?:of\s+)?([A-Z]{2,4}-\d{2,4})\b/gi;
const SKU_FIRST_RE =
  /\b([A-Z]{2,4}-\d{2,4})\b[^\n\d]{0,40}?(?:qty|quantity|x)\s*[:=]?\s*(\d{1,6})/gi;

export function extractHeuristic(text: string): Extracted {
  const lines = new Map<string, number>();
  for (const m of text.matchAll(LINE_RE)) lines.set(m[2]!.toUpperCase(), Number(m[1]));
  for (const m of text.matchAll(SKU_FIRST_RE)) lines.set(m[1]!.toUpperCase(), Number(m[2]));
  const po = /\bPO\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9-]{3,})/i.exec(text)?.[1] ?? null;
  // "From" or "from", then a capitalised name. Not /i: that would let the name match any lowercase
  // run of words after "from" in the body ("from the warehouse").
  const from =
    /\b[Ff]rom\s*[:-]?\s*([A-Z][\w&. ]{2,40}?)(?:\n|,|<|$)/.exec(text)?.[1]?.trim() ?? null;
  return {
    customerName: from,
    poNumber: po,
    lines: [...lines].map(([sku, qty]) => ({ sku, qty })),
    notes: null,
  };
}

export async function extractOrder(
  env: Env,
  text: string,
  catalog: { sku: string; name: string }[],
) {
  return runJson<Extracted>(
    env,
    [
      {
        role: 'system',
        content: `You extract orders from emails and documents: purchase orders, order forms and customer messages. poNumber is the buyer's order or PO reference. Map every requested item to a SKU from this catalog, using the closest name match: ${JSON.stringify(catalog)}. Use null when unknown. Quantities are integers.`,
      },
      { role: 'user', content: text.slice(0, 20_000) },
    ],
    {
      type: 'object',
      properties: {
        customerName: { type: ['string', 'null'] },
        poNumber: { type: ['string', 'null'] },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { sku: { type: 'string' }, qty: { type: 'number' } },
            required: ['sku', 'qty'],
          },
        },
        notes: { type: ['string', 'null'] },
      },
      required: ['customerName', 'poNumber', 'lines'],
    },
    () => extractHeuristic(text),
  );
}

// ── Classify ───────────────────────────────────────────────────────────────

const KEYWORDS: Record<string, string[]> = {
  it_hardware: ['laptop', 'monitor', 'lap-', 'mon-', 'keyboard', 'server'],
  software: ['license', 'saas', 'subscription', 'software'],
  office_supplies: ['paper', 'pen', 'toner', 'chair'],
  services: ['consult', 'service', 'contractor', 'install'],
  travel: ['flight', 'hotel', 'travel'],
};

export async function classify(env: Env, order: Order, labels: string[]) {
  return runJson<{ label: string; confidence: number }>(
    env,
    [
      {
        role: 'system',
        content: `Classify this order into exactly one of: ${labels.join(', ')}. Reply with the label and a confidence from 0 to 1.`,
      },
      { role: 'user', content: brief(order) },
    ],
    {
      type: 'object',
      properties: { label: { type: 'string', enum: labels }, confidence: { type: 'number' } },
      required: ['label', 'confidence'],
    },
    () => {
      const text =
        `${order.title ?? ''} ${order.lines.map((l) => `${l.sku} ${l.name ?? ''}`).join(' ')}`.toLowerCase();
      const hit = labels.find((l) => (KEYWORDS[l] ?? [l]).some((k) => text.includes(k)));
      return { label: hit ?? labels[0]!, confidence: hit ? 0.7 : 0.3 };
    },
  ).then((r) => ({
    ...r,
    value: { ...r.value, label: labels.includes(r.value.label) ? r.value.label : labels[0]! },
  }));
}

// ── Risk ───────────────────────────────────────────────────────────────────

export async function riskScore(env: Env, order: Order, customer: unknown) {
  return runJson<{ score: number; reasons: string[] }>(
    env,
    [
      {
        role: 'system',
        content:
          'You assess fraud and credit risk for commerce orders. Score 0 (safe) to 100 (block). Give up to three short reasons.',
      },
      { role: 'user', content: JSON.stringify({ order: JSON.parse(brief(order)), customer }) },
    ],
    {
      type: 'object',
      properties: {
        score: { type: 'number' },
        reasons: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'reasons'],
    },
    () => {
      const reasons: string[] = [];
      let score = 10;
      if (!order.customerId) {
        score += order.contact ? 15 : 30;
        reasons.push(order.contact ? 'Guest checkout' : 'Unknown customer');
      }
      if ((order.baseTotal ?? order.total) > 20_000)
        (score += 30), reasons.push('High order value');
      if (order.lines.some((l) => l.qty > 1000)) (score += 20), reasons.push('Unusual quantity');
      return { score: Math.min(score, 100), reasons };
    },
  );
}

// ── Forecast ───────────────────────────────────────────────────────────────

type StockRow = {
  sku: string;
  name: string;
  stock: number;
  reserved: number;
  reorderPoint: number;
  reorderQty: number;
  cost: number;
  supplier: string;
};

export async function forecast(env: Env, rows: StockRow[], horizonDays: number) {
  const low = rows.filter((r) => r.stock - r.reserved <= r.reorderPoint);
  const fallback = () => ({
    lines: low.map((r) => ({ sku: r.sku, qty: r.reorderQty, reason: 'At or below reorder point' })),
  });
  if (!low.length)
    return {
      value: { lines: [] as { sku: string; qty: number; reason: string }[] },
      source: 'heuristic' as AiSource,
    };
  return runJson<{ lines: { sku: string; qty: number; reason: string }[] }>(
    env,
    [
      {
        role: 'system',
        content: `You plan inventory replenishment for the next ${horizonDays} days. For each SKU at or below its reorder point, suggest an order quantity (use reorderQty as the baseline, adjust if stock is far below the point). Only include the SKUs given.`,
      },
      { role: 'user', content: JSON.stringify(low) },
    ],
    {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              qty: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['sku', 'qty', 'reason'],
          },
        },
      },
      required: ['lines'],
    },
    fallback,
  ).then((r) => {
    const valid = new Set(low.map((x) => x.sku));
    const lines = r.value.lines.filter((l) => valid.has(l.sku) && l.qty > 0);
    return lines.length
      ? { ...r, value: { lines } }
      : { value: fallback(), source: 'heuristic' as AiSource };
  });
}

// ── Router ─────────────────────────────────────────────────────────────────

export async function route(
  env: Env,
  instructions: string,
  routes: string[],
  context: Record<string, unknown>,
) {
  return runJson<{ route: string; reason: string }>(
    env,
    [
      {
        role: 'system',
        content: `${instructions}\n\nChoose exactly one route from: ${routes.join(', ')}. Explain the decision in one sentence a customer could read.`,
      },
      { role: 'user', content: JSON.stringify(context) },
    ],
    {
      type: 'object',
      properties: { route: { type: 'string', enum: routes }, reason: { type: 'string' } },
      required: ['route', 'reason'],
    },
    () => {
      const order = context.order as Order;
      const pick = (want: string, fb: string) => (routes.includes(want) ? want : fb);
      if (!order.lines.length)
        return {
          route: pick('ask_customer', routes.at(-1)!),
          reason: 'No lines could be matched to our catalog.',
        };
      if ((order.baseTotal ?? order.total) > 10_000)
        return {
          route: pick('needs_approval', routes[0]!),
          reason: 'Order total is above $10,000.',
        };
      return { route: routes[0]!, reason: 'Routine order; nothing unusual stands out.' };
    },
  ).then((r) => ({
    ...r,
    value: { ...r.value, route: routes.includes(r.value.route) ? r.value.route : routes[0]! },
  }));
}

export async function summarize(env: Env, context: Record<string, unknown>) {
  return runJson<{ summary: string }>(
    env,
    [
      {
        role: 'system',
        content: 'Summarize this order and its progress in two sentences for an operations team.',
      },
      { role: 'user', content: JSON.stringify(context).slice(0, 20_000) },
    ],
    { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    () => {
      const o = context.order as Order;
      return {
        summary: `${ORDER_MODEL_LABELS[o.model]} order ${o.id}: ${o.lines.length} lines, total ${o.total.toFixed(2)} ${o.currency}.`,
      };
    },
  );
}

// ── Copilot ────────────────────────────────────────────────────────────────

const CATALOG_BRIEF = NODE_SPECS.map((s) => ({
  type: s.type,
  label: s.label,
  description: s.description,
  outputs: typeof s.outputs === 'function' ? 'one output per entry in config.routes' : s.outputs,
  config: Object.fromEntries(
    s.fields.map((f) => [f.key, f.kind + (f.options ? `(${f.options.join('|')})` : '')]),
  ),
}));

export async function copilot(env: Env, req: CopilotRequest): Promise<CopilotResult> {
  const { value } = await runJson<{ explanation: string; graph: FlowGraph }>(
    env,
    [
      {
        role: 'system',
        content: `You design order-processing flows as graphs. Node types:\n${JSON.stringify(CATALOG_BRIEF)}\n
Rules: exactly one trigger node. Edges: {id, source, target, sourceHandle}. sourceHandle is one of the source node's outputs (omit for "out"). Every non-trigger node needs an incoming edge. No cycles, except a back-edge into a control.loop node with targetHandle "next" from inside its body. Conditions are JSON Logic over {order, nodes, vars}. Node ids are short snake_case. Keep existing node ids when editing. Return the complete graph.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          request: req.prompt,
          model: req.model,
          side: req.model ? (isBuySide(req.model) ? 'buy (priced at cost)' : 'sell') : undefined,
          current: req.graph ?? null,
        }),
      },
    ],
    {
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        graph: {
          type: 'object',
          properties: {
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  label: { type: 'string' },
                  config: { type: 'object' },
                },
                required: ['id', 'type', 'label'],
              },
            },
            edges: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  source: { type: 'string' },
                  target: { type: 'string' },
                  sourceHandle: { type: 'string' },
                  targetHandle: { type: 'string' },
                },
                required: ['source', 'target'],
              },
            },
          },
          required: ['nodes', 'edges'],
        },
      },
      required: ['explanation', 'graph'],
    },
    () => copilotHeuristic(req),
  );
  const graph = normalizeGraph(value.graph, req.graph);
  const { errors, warnings } = validateGraph(graph);
  return { graph, explanation: value.explanation, errors, warnings };
}

/** Coerces model output into a valid-shaped graph: defaults, edge ids, positions kept or laid out. */
export function normalizeGraph(raw: FlowGraph, previous?: FlowGraph): FlowGraph {
  const prevPos = new Map(previous?.nodes.map((n) => [n.id, n.position]) ?? []);
  const parsed = flowGraphSchema.safeParse({
    nodes: (raw?.nodes ?? []).map((n) => ({
      ...n,
      id: String(n.id)
        .replace(/[^\w-]/g, '_')
        .slice(0, 40),
      config: withDefaults(n.type, (n.config as Record<string, unknown>) ?? {}),
      position: prevPos.get(n.id) ?? { x: 0, y: 0 },
    })),
    edges: (raw?.edges ?? []).map((e, i) => ({
      ...e,
      id: e.id || `e${i}_${e.source}_${e.target}`,
      sourceHandle: e.sourceHandle && e.sourceHandle !== 'out' ? e.sourceHandle : null,
      targetHandle: e.targetHandle || null,
    })),
  });
  if (!parsed.success) return previous ?? { nodes: [], edges: [] };
  const g = parsed.data;
  const moved = g.nodes.some((n) => !prevPos.has(n.id));
  return moved ? autoLayout(g) : g;
}

/** Offline copilot: understands "add a <node type> after <node id>". */
export function copilotHeuristic(req: CopilotRequest): { explanation: string; graph: FlowGraph } {
  const graph: FlowGraph = structuredClone(req.graph ?? { nodes: [], edges: [] });
  // "after the credit check" means the same as "after credit check".
  const p = req.prompt.toLowerCase().replace(/\b(the|a|an)\s+/g, '');
  const spec =
    NODE_SPECS.find((s) => p.includes(s.label.toLowerCase())) ??
    (p.includes('fraud') || p.includes('risk')
      ? NODE_SPECS.find((s) => s.type === 'ai.risk_score')
      : undefined);
  const after = graph.nodes.find(
    (n) => p.includes(`after ${n.id}`) || p.includes(`after ${n.label.toLowerCase()}`),
  );
  if (!spec || !after) {
    return {
      explanation:
        'Without the model, it follows requests like “add a risk score after credit check”.',
      graph,
    };
  }
  const id = `${spec.type.split('.')[1]}_${graph.nodes.length}`;
  const outs = graph.edges.filter((e) => e.source === after.id);
  graph.nodes.push({
    id,
    type: spec.type,
    label: spec.label,
    config: withDefaults(spec.type),
    position: after.position,
  });
  const first = nodeOutputs(spec.type, withDefaults(spec.type))[0] ?? 'out';
  for (const e of outs) {
    graph.edges.push({
      ...e,
      id: `${e.id}_via_${id}`,
      source: id,
      sourceHandle: first === 'out' ? null : first,
    });
    e.target = id;
    e.targetHandle = null;
  }
  if (!outs.length) graph.edges.push({ id: `${after.id}-${id}`, source: after.id, target: id });
  return { explanation: `Added ${spec.label} after ${after.label}.`, graph: autoLayout(graph) };
}
