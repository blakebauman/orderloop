import { env } from 'cloudflare:workers';
import { TEMPLATES } from '@orderloop/core';
import { createDb, flowVersions, getFlowVersionJson, publishFlow, seedFlows } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';

const db = () => createDb(env.DB);
const versions = async (id: string) =>
  (await db().select().from(flowVersions).where(eq(flowVersions.flowId, id))).length;

const flow = (label: string) => ({
  id: 'test-seed',
  name: 'Seed',
  description: '',
  model: 'b2b',
  channels: [],
  nodes: [{ id: 'start', type: 'trigger.manual', label, config: {}, position: { x: 0, y: 0 } }],
  edges: [],
});

describe('template seeding', () => {
  it('publishes every template, once', async () => {
    await ensureTemplates(env);
    await ensureTemplates(env);
    for (const [id, build] of Object.entries(TEMPLATES)) {
      expect((await getFlowVersionJson(db(), id))?.flow).toEqual(build());
      expect(await versions(id)).toBe(1);
    }
  });

  it('publishes a changed template as the next version, over edits made since', async () => {
    await seedFlows(db(), [flow('v1')]);
    await publishFlow(db(), flow('edited in the app'));
    await seedFlows(db(), [flow('v2')]);
    const latest = await getFlowVersionJson(db(), 'test-seed');
    expect(latest?.version).toBe(3);
    expect(latest?.flow.nodes[0]).toMatchObject({ label: 'v2' });
  });

  it('leaves a template alone that was already published, so older code can’t roll it back', async () => {
    const before = await versions('test-seed');
    await seedFlows(db(), [flow('v1')]);
    await seedFlows(db(), [flow('v2')]);
    expect(await versions('test-seed')).toBe(before);
    expect((await getFlowVersionJson(db(), 'test-seed'))?.version).toBe(3);
  });
});

describe('publishing', () => {
  const other = (label: string) => ({ ...flow(label), id: 'test-race' });

  it('numbers racing publishes one after another instead of failing', async () => {
    const got = await Promise.all([
      publishFlow(db(), other('a')),
      publishFlow(db(), other('b')),
      publishFlow(db(), other('c')),
    ]);
    expect([...got].sort()).toEqual([1, 2, 3]);
    expect((await getFlowVersionJson(db(), 'test-race'))?.version).toBe(3);
  });

  it('seeds a template once when two isolates seed it at the same time', async () => {
    const t = { ...flow('same'), id: 'test-race-seed' };
    await Promise.all([seedFlows(db(), [t]), seedFlows(db(), [t]), seedFlows(db(), [t])]);
    expect(await versions('test-race-seed')).toBe(1);
  });
});
