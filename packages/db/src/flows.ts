/**
 * Flow persistence. Graphs are stored as JSON; @orderloop/core owns their shape and validation,
 * so these helpers take and return plain JSON-able objects.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
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

/** Saves the draft and snapshots it as the next version. Returns the new version number. */
export async function publishFlow(db: Db, flow: StoredFlow, now = Date.now()): Promise<number> {
  await saveDraft(db, flow, now);
  const latest = await db
    .select({ v: flowVersions.version })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flow.id))
    .orderBy(desc(flowVersions.version))
    .limit(1)
    .get();
  const version = (latest?.v ?? 0) + 1;
  await db.insert(flowVersions).values({
    flowId: flow.id,
    version,
    flowJson: JSON.stringify(flow),
    publishedAt: now,
  });
  await db
    .update(flows)
    .set({ publishedVersion: version, updatedAt: now })
    .where(eq(flows.id, flow.id));
  return version;
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
  for (const f of all) if (!published.has(JSON.stringify(f))) await publishFlow(db, f);
}
