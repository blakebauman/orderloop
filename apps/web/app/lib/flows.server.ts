import { env } from 'cloudflare:workers';
import {
  type Flow,
  type FlowGraph,
  flowGraphSchema,
  ORDER_CHANNELS,
  ORDER_MODELS,
  type OrderChannel,
  type OrderModel,
  parseOrderRoutes,
  TEMPLATES,
  validateGraph,
} from '@orderloop/core';
import {
  flows,
  flowVersions,
  getFlowVersionJson,
  publishFlow,
  saveDraft,
  seedFlows,
} from '@orderloop/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { isDemo } from './demo.server';
import { db } from './env.server';
import { summarizeFlow } from './new-order';

let seeded = false;

/**
 * Publishes the built-in templates on first use (cheap no-op afterwards). A demo checks every
 * time, since its nightly reset removes them while isolates stay warm.
 */
export async function ensureSeeded() {
  if (seeded && !isDemo()) return;
  await seedFlows(
    db(),
    Object.values(TEMPLATES).map((t) => t()),
  );
  seeded = true;
}

/**
 * Every flow for the flows list: its draft's step summary, the live version and whether the draft
 * has changed since it was published. Archived drafts only with `archived`.
 */
export async function listFlows({ archived = false } = {}) {
  await ensureSeeded();
  const rows = await db()
    .select({
      id: flows.id,
      name: flows.name,
      description: flows.description,
      model: flows.model,
      channels: flows.channels,
      publishedVersion: flows.publishedVersion,
      updatedAt: flows.updatedAt,
      archivedAt: flows.archivedAt,
      graphJson: flows.graphJson,
      publishedJson: flowVersions.flowJson,
      publishedAt: flowVersions.publishedAt,
    })
    .from(flows)
    .leftJoin(
      flowVersions,
      and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.publishedVersion)),
    )
    .where(archived ? sql`${flows.archivedAt} is not null` : isNull(flows.archivedAt))
    .orderBy(flows.name);
  return rows.map(({ graphJson, publishedJson, channels, ...r }) => {
    const g = JSON.parse(graphJson) as FlowGraph;
    const live = publishedJson ? (JSON.parse(publishedJson) as FlowGraph) : null;
    return {
      ...r,
      model: r.model as OrderModel,
      channels: JSON.parse(channels) as OrderChannel[],
      nodeCount: g.nodes.length,
      summary: summarizeFlow(g),
      /** Published, and the draft has changed since. */
      dirty: !!live && !sameGraph(g, { nodes: live.nodes, edges: live.edges }),
    };
  });
}

/** `ORDER_ROUTES`: inbound `model:channel` (or `model:*`) to flow id. */
export const orderRoutes = () => parseOrderRoutes((env as { ORDER_ROUTES?: string }).ORDER_ROUTES);

/** The flow's name, or null when there is no such flow. */
export async function flowName(id: string) {
  const row = await db().select({ name: flows.name }).from(flows).where(eq(flows.id, id)).get();
  return row?.name ?? null;
}

/**
 * Archives or restores a draft. Only a flow that was never published: no order can be on it, and no
 * route can start one. Returns false for anything else.
 */
export async function setArchived(id: string, archived: boolean) {
  const res = await db()
    .update(flows)
    .set({ archivedAt: archived ? Date.now() : null })
    .where(and(eq(flows.id, id), isNull(flows.publishedVersion)))
    .returning({ id: flows.id });
  return res.length > 0;
}

export async function getFlow(id: string) {
  await ensureSeeded();
  const row = await db().select().from(flows).where(eq(flows.id, id)).get();
  if (!row) return null;
  const graph = JSON.parse(row.graphJson) as FlowGraph;
  const published = await getFlowVersionJson(db(), id);
  const versions = await db()
    .select({ version: flowVersions.version, publishedAt: flowVersions.publishedAt })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, id))
    .orderBy(desc(flowVersions.version));
  const flow: Flow = {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model as OrderModel,
    channels: JSON.parse(row.channels) as OrderChannel[],
    ...graph,
  };
  const dirty =
    !published ||
    JSON.stringify({ nodes: published.flow.nodes, edges: published.flow.edges }) !==
      JSON.stringify(graph);
  const publishedGraph: FlowGraph | null = published
    ? ({ nodes: published.flow.nodes, edges: published.flow.edges } as FlowGraph)
    : null;
  return {
    flow,
    publishedVersion: row.publishedVersion,
    versions,
    dirty,
    publishedGraph,
  };
}

export function parseFlow(input: unknown): Flow {
  const o = input as Record<string, unknown>;
  const graph = flowGraphSchema.parse({ nodes: o.nodes, edges: o.edges });
  const model = ORDER_MODELS.includes(o.model as OrderModel) ? (o.model as OrderModel) : 'b2c';
  const channels = Array.isArray(o.channels)
    ? ORDER_CHANNELS.filter((c) => (o.channels as unknown[]).includes(c))
    : [];
  return {
    id:
      String(o.id ?? '')
        .replace(/[^\w-]/g, '')
        .slice(0, 60) || `flow-${Date.now().toString(36)}`,
    name: String(o.name ?? 'Untitled flow').slice(0, 80),
    description: String(o.description ?? '').slice(0, 500),
    model,
    channels,
    ...graph,
  };
}

export async function saveFlow(flow: Flow) {
  await saveDraft(db(), flow);
  return validateGraph(flow);
}

/** Publishes a new version, recording who published it (as the audit trail names them). */
export async function publish(flow: Flow, publishedBy: string) {
  const issues = validateGraph(flow);
  if (issues.errors.length) return { ...issues, version: null };
  const version = await publishFlow(db(), flow, Date.now(), { publishedBy });
  return { ...issues, version };
}

export async function flowCount() {
  const r = await db().select({ n: sql<number>`count(*)` }).from(flows).get();
  return r?.n ?? 0;
}

/** Same nodes and edges, ignoring array order (the editor appends; the store keeps insertion order). */
export function sameGraph(a: FlowGraph, b: FlowGraph) {
  const norm = (g: FlowGraph) =>
    JSON.stringify({
      nodes: [...g.nodes].sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...g.edges].sort((x, y) => x.id.localeCompare(y.id)),
    });
  return norm(a) === norm(b);
}
