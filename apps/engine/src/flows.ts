import { type FlowVersion, TEMPLATES } from '@orderloop/core';
import { createDb, getFlowVersionJson, seedFlows } from '@orderloop/db';

export async function loadFlowVersion(
  env: Env,
  flowId: string,
  version?: number,
): Promise<FlowVersion | null> {
  const row = await getFlowVersionJson(createDb(env.DB), flowId, version);
  if (!row) return null;
  return {
    ...(row.flow as unknown as FlowVersion),
    version: row.version,
    publishedAt: row.publishedAt,
  };
}

/** Publishes the built-in templates the first time. */
export async function ensureTemplates(env: Env) {
  await seedFlows(
    createDb(env.DB),
    Object.values(TEMPLATES).map((t) => t()),
  );
}
