import { env } from 'cloudflare:workers';
import {
  type Flow,
  type FlowGraph,
  type OrderChannel,
  type OrderModel,
  parseOrderRoutes,
  TEMPLATES,
} from '@orderloop/core';
import { flows, flowVersions, getFlowVersionJson, seedFlows } from '@orderloop/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { isDemo } from './demo.server';
import { db } from './env.server';
import { summarizeFlow } from './new-order';
import { nodeRegistry } from './plugins.server';

let seededAt: number | null = null;

/** How long a demo trusts its last check: its nightly reset removes the templates. */
const DEMO_RESEED_MS = 60_000;

/**
 * Publishes the built-in templates on first use (cheap no-op afterwards). A demo checks again
 * after a minute, since its nightly reset removes them while isolates stay warm.
 */
export async function ensureSeeded() {
  if (seededAt !== null && (!isDemo() || Date.now() - seededAt < DEMO_RESEED_MS)) return;
  await seedFlows(
    db(),
    Object.values(TEMPLATES).map((t) => t()),
  );
  seededAt = Date.now();
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
  const nodes = await nodeRegistry();
  return rows.map(({ graphJson, publishedJson, channels, ...r }) => {
    const g = JSON.parse(graphJson) as FlowGraph;
    const live = publishedJson ? (JSON.parse(publishedJson) as FlowGraph) : null;
    return {
      ...r,
      model: r.model as OrderModel,
      channels: JSON.parse(channels) as OrderChannel[],
      nodeCount: g.nodes.length,
      summary: summarizeFlow(g, nodes),
      /** Published, and the draft has changed since. */
      dirty: !!live && !sameGraph(g, { nodes: live.nodes, edges: live.edges }),
    };
  });
}

/**
 * Each flow's name and its steps' labels in the order a reader meets them: left to right, then top
 * to bottom, as the editor lays a flow out. From the published version, or the draft if there is
 * none. For placing the overview's waits and failures along their flow; display only.
 */
export async function flowSteps(): Promise<{ id: string; name: string; steps: string[] }[]> {
  const rows = await db()
    .select({
      id: flows.id,
      name: flows.name,
      graphJson: flows.graphJson,
      publishedJson: flowVersions.flowJson,
    })
    .from(flows)
    .leftJoin(
      flowVersions,
      and(eq(flowVersions.flowId, flows.id), eq(flowVersions.version, flows.publishedVersion)),
    );
  return rows.map((r) => {
    const g = JSON.parse(r.publishedJson ?? r.graphJson) as FlowGraph;
    const steps = [...g.nodes]
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
      .map((n) => n.label);
    return { id: r.id, name: r.name, steps };
  });
}

/** `ORDER_ROUTES`: inbound `model:channel` (or `model:*`) to flow id. */
export const orderRoutes = () => parseOrderRoutes((env as { ORDER_ROUTES?: string }).ORDER_ROUTES);

/** The flow's name, or null when there is no such flow. */
export async function flowName(id: string) {
  const row = await db().select({ name: flows.name }).from(flows).where(eq(flows.id, id)).get();
  return row?.name ?? null;
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

export async function flowCount() {
  const r = await db().select({ n: sql<number>`count(*)` }).from(flows).get();
  return r?.n ?? 0;
}
/** Same nodes and edges, ignoring array order (the editor appends; the store keeps insertion order). */
function sameGraph(a: FlowGraph, b: FlowGraph) {
  const norm = (g: FlowGraph) =>
    JSON.stringify({
      nodes: [...g.nodes].sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...g.edges].sort((x, y) => x.id.localeCompare(y.id)),
    });
  return norm(a) === norm(b);
}
