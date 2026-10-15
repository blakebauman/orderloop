/**
 * Flow persistence. Graphs are stored as JSON; @orderloop/core owns their shape and validation,
 * so these helpers take and return plain JSON-able objects.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './index';
import { flows, flowVersions } from './schema';

export type StoredFlow = {
  id: string;
  name: string;
  description: string;
  model: string;
  channels: string[];
  nodes: unknown[];
  edges: unknown[];
};

export async function getFlowVersionJson(db: Db, flowId: string, version?: number) {
  const row = await db
    .select()
    .from(flowVersions)
    .where(
      version === undefined
        ? eq(flowVersions.flowId, flowId)
        : and(eq(flowVersions.flowId, flowId), eq(flowVersions.version, version)),
    )
    .orderBy(desc(flowVersions.version))
    .limit(1)
    .get();
  return row
    ? {
        version: row.version,
        publishedAt: row.publishedAt,
        flow: JSON.parse(row.flowJson) as StoredFlow,
      }
    : null;
}

/**
 * Saves the draft and snapshots it as the next version. Returns the new version number.
 *
 * The version is numbered and inserted in one statement, so two publishes racing (two isolates
 * seeding templates on their first request, say) get consecutive versions instead of one failing
 * on the primary key. With `unlessPublished`, nothing is inserted when this exact content is
 * already a version, and the latest version is returned.
 */
export async function publishFlow(
  db: Db,
  flow: StoredFlow,
  now = Date.now(),
  {
    unlessPublished = false,
    publishedBy = null,
  }: { unlessPublished?: boolean; publishedBy?: string | null } = {},
): Promise<number> {
  await saveDraft(db, flow, now);
  const flowJson = JSON.stringify(flow);
  const next = db
    .select({ v: sql<number>`coalesce(max(${flowVersions.version}), 0) + 1`.as('v') })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flow.id))
    .as('next');
  const [row] = await db
    .insert(flowVersions)
    .select(
      db
        .select({
          flowId: sql<string>`${flow.id}`.as('flow_id'),
          version: next.v,
          flowJson: sql<string>`${flowJson}`.as('flow_json'),
          publishedAt: sql<number>`${now}`.as('published_at'),
          publishedBy: sql<string | null>`${publishedBy}`.as('published_by'),
        })
        .from(next)
        .where(
          unlessPublished
            ? sql`not exists (select 1 from ${flowVersions} where ${and(eq(flowVersions.flowId, flow.id), eq(flowVersions.flowJson, flowJson))})`
            : undefined,
        ),
    )
    .returning({ version: flowVersions.version });
  // Points at the highest version, whichever of two racing publishes wrote it.
  await db
    .update(flows)
    .set({
      publishedVersion: sql`(select max(${flowVersions.version}) from ${flowVersions} where ${eq(flowVersions.flowId, flow.id)})`,
      updatedAt: now,
    })
    .where(eq(flows.id, flow.id));
  if (row) return row.version;
  const latest = await getFlowVersionJson(db, flow.id);
  return latest?.version ?? 0;
}

export async function saveDraft(db: Db, flow: StoredFlow, now = Date.now()) {
  const graphJson = JSON.stringify({ nodes: flow.nodes, edges: flow.edges });
  await db
    .insert(flows)
    .values({
      id: flow.id,
      name: flow.name,
      description: flow.description,
      model: flow.model,
      channels: JSON.stringify(flow.channels),
      graphJson,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: flows.id,
      set: {
        name: flow.name,
        description: flow.description,
        model: flow.model,
        channels: JSON.stringify(flow.channels),
        graphJson,
        updatedAt: now,
      },
    });
}

/**
 * Publishes each template whose exact content has never been published: a new template as version
 * 1, a changed one as the next version (replacing edits made since). A template that matches any
 * earlier version is left alone, so code still running from before a change can't republish its
 * older copy over the newer one. Safe to call on every request.
 */
export async function seedFlows(db: Db, all: StoredFlow[]) {
  if (!all.length) return;
  const published = new Set(
    (
      await db
        .select({ flowJson: flowVersions.flowJson })
        .from(flowVersions)
        .where(
          inArray(
            flowVersions.flowId,
            all.map((f) => f.id),
          ),
        )
    ).map((r) => r.flowJson),
  );
  for (const f of all)
    if (!published.has(JSON.stringify(f)))
      await publishFlow(db, f, Date.now(), { unlessPublished: true });
}
