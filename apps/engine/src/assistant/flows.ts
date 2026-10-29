/**
 * Editing flows through the assistant: the editor's Save, new flows (a template, a blank start, or
 * one drafted from a description), duplicates, archiving, and a test run. Publishing is
 * `publish_flow` (data.ts). Nothing here changes what a running order does: a draft runs only once
 * it is published, which waits for a confirm, and so does a test run, which may publish.
 *
 * Saving a draft overwrites the one there, so only the editor's own button saves
 * (`PAGE_ONLY_TOOLS`); a model proposes a change instead (`propose_flow_change`), which the person
 * applies in the editor and saves.
 */

import {
  type ActionPreview,
  ASSISTANT_BUDGET_SPENT,
  autoLayout,
  DEFAULT_TEMPLATE,
  describeDiff,
  type Flow,
  type FlowGraph,
  fingerprintOf,
  graphDiff,
  ORDER_CHANNELS,
  type OrderChannel,
  type OrderModel,
  type Principal,
  SCENARIO_CUSTOMERS,
  SCENARIO_SKUS,
  SCENARIOS,
  TEMPLATES,
  validateGraph,
} from '@orderloop/core';
import {
  createDb,
  customers,
  flows,
  getFlowVersionJson,
  products,
  publishFlow,
  saveDraft,
} from '@orderloop/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { copilot } from '../ai';
import { recordAudit } from '../audit';
import { startOrderOnce } from '../orders';
import { registry } from '../plugins';
import { assistantBudgetSpent } from '../usage';
import { type Confirmed, orderRef, Refused } from './data';

type Trail = Record<string, unknown>;

export type FlowDraft = {
  flowId: string;
  name: string;
  description?: string;
  model: OrderModel;
  channels?: OrderChannel[];
} & FlowGraph;

async function draftOf(env: Env, flowId: string) {
  const row = await createDb(env.DB).select().from(flows).where(eq(flows.id, flowId)).get();
  if (!row) throw new Refused(`No flow has the id ${flowId}.`);
  const graph = JSON.parse(row.graphJson) as FlowGraph;
  const flow: Flow = {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model as OrderModel,
    channels: JSON.parse(row.channels) as OrderChannel[],
    ...graph,
  };
  return { row, flow };
}

/** The editor's Save: the draft as on screen, with what its checks found. */
export async function saveFlowDraft(env: Env, p: Principal, d: FlowDraft, trail: Trail) {
  await draftOf(env, d.flowId);
  const flow: Flow = {
    id: d.flowId,
    name: d.name,
    description: d.description ?? '',
    model: d.model,
    channels: (d.channels ?? []).filter((c) => ORDER_CHANNELS.includes(c)),
    nodes: d.nodes,
    edges: d.edges,
  };
  await saveDraft(createDb(env.DB), flow);
  const { errors, warnings } = validateGraph(flow, await registry(env));
  await recordAudit(env, 'flow.saved', {
    actor: p,
    target: flow.id,
    detail: { name: flow.name, ...trail },
  });
  return {
    done: `Saved the draft of ${flow.name}`,
    href: `/flows/${flow.id}`,
    id: flow.id,
    errors,
    warnings,
  };
}

const slug = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'flow'
  }-${crypto.randomUUID().slice(0, 8)}`;

/**
 * An id no flow has yet, for a new flow. Saving a draft is an upsert, so a clash would write over
 * another flow's draft: a taken id is never used.
 */
async function freshId(env: Env, name: string) {
  const db = createDb(env.DB);
  for (let i = 0; i < 3; i++) {
    const id = slug(name);
    if (!(await db.select({ id: flows.id }).from(flows).where(eq(flows.id, id)).get())) return id;
  }
  throw new Refused('Could not pick an unused id for the flow. Try again.');
}

const BLANK: FlowGraph = {
  nodes: [
    {
      id: 'start',
      type: 'trigger.manual',
      label: 'Start',
      config: {},
      position: { x: 56, y: 160 },
    },
  ],
  edges: [],
};

/** A new, unpublished flow: its model's template, a blank start, or drafted from a description. */
export async function createFlow(
  env: Env,
  p: Principal,
  i: { name: string; model: OrderModel; start: 'template' | 'blank' | 'describe'; prompt?: string },
  trail: Trail,
) {
  let graph: FlowGraph = BLANK;
  let description = '';
  let channels: OrderChannel[] = [];
  if (i.start === 'describe') {
    if (!i.prompt?.trim()) throw new Refused('Describe the steps you want, then draft again.');
    // A draft from a description calls a model, so it counts against the person's daily budget.
    if (await assistantBudgetSpent(env, p)) throw new Refused(ASSISTANT_BUDGET_SPENT);
    const res = await copilot(env, { prompt: i.prompt, model: i.model });
    if (!res.graph.nodes.length)
      throw new Refused(`The assistant could not draft that. ${res.explanation}`);
    graph = autoLayout(res.graph);
    description = i.prompt.slice(0, 300);
  } else if (i.start === 'template') {
    const t = TEMPLATES[DEFAULT_TEMPLATE[i.model]]();
    graph = { nodes: t.nodes, edges: t.edges };
    description = t.description;
    channels = t.channels;
  }
  const id = await freshId(env, i.name);
  await saveDraft(createDb(env.DB), {
    id,
    name: i.name,
    description,
    model: i.model,
    channels,
    ...graph,
  });
  await recordAudit(env, 'flow.saved', {
    actor: p,
    target: id,
    detail: { name: i.name, ...trail },
  });
  return { done: `Created ${i.name}`, href: `/flows/${id}`, id };
}

/** The flow's current draft as a new, unpublished flow. */
export async function duplicateFlow(env: Env, p: Principal, flowId: string, trail: Trail) {
  const { flow } = await draftOf(env, flowId);
  const name = `${flow.name} (copy)`.slice(0, 80);
  const id = await freshId(env, name);
  await saveDraft(createDb(env.DB), { ...flow, id, name });
  await recordAudit(env, 'flow.saved', {
    actor: p,
    target: id,
    detail: { name, from: flow.id, ...trail },
  });
  return { done: `Duplicated ${flow.name}`, href: `/flows/${id}`, id };
}

/** Archives or restores a draft that was never published, so nothing can be running on it. */
export async function setFlowArchived(
  env: Env,
  p: Principal,
  flowId: string,
  archived: boolean,
  trail: Trail,
) {
  const res = await createDb(env.DB)
    .update(flows)
    .set({ archivedAt: archived ? Date.now() : null })
    .where(and(eq(flows.id, flowId), isNull(flows.publishedVersion)))
    .returning({ id: flows.id, name: flows.name });
  if (!res.length) throw new Refused('Only a draft that was never published can be archived.');
  await recordAudit(env, archived ? 'flow.archived' : 'flow.restored', {
    actor: p,
    target: flowId,
    detail: trail,
  });
  return {
    done: `${archived ? 'Archived' : 'Restored'} ${res[0]!.name}`,
    href: '/flows',
    id: flowId,
  };
}

/** A demo scenario's input for a test run, when the demo data is loaded; else an empty order. */
async function sampleFor(env: Env, flow: Flow) {
  const db = createDb(env.DB);
  const [c, p] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(customers)
      .where(inArray(customers.id, SCENARIO_CUSTOMERS))
      .get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(products)
      .where(inArray(products.sku, SCENARIO_SKUS))
      .get(),
  ]);
  const demo = c?.n === SCENARIO_CUSTOMERS.length && p?.n === SCENARIO_SKUS.length;
  return demo
    ? (SCENARIOS.find((s) => s.flowId === flow.id) ??
        SCENARIOS.find((s) => s.input.model === flow.model))
    : undefined;
}

/** What a test run does: publishes the saved draft first when it changed, then starts an order. */
async function testPlan(env: Env, flowId: string) {
  const { row, flow } = await draftOf(env, flowId);
  const { errors } = validateGraph(flow, await registry(env));
  const live = row.publishedVersion
    ? await getFlowVersionJson(createDb(env.DB), row.id, row.publishedVersion)
    : null;
  const diff = live
    ? describeDiff(graphDiff(live.flow as unknown as FlowGraph, flow))
    : 'First version';
  return {
    row,
    flow,
    errors,
    publishes: !live || !!diff,
    diff,
    sample: await sampleFor(env, flow),
  };
}

/** What a publish's card showed of the draft, so the confirm publishes that draft and no other. */
export const draftHash = (f: Flow) =>
  fingerprintOf({
    name: f.name,
    description: f.description,
    model: f.model,
    channels: f.channels,
    nodes: f.nodes,
    edges: f.edges,
  });

export const DRAFT_CHANGED = 'The draft changed since you confirmed; look at it again.';

/**
 * Refuses a publish whose card showed another draft (`bound`, held by the panel and MCP), and one
 * held to nothing (a card never shown, or shown differently since). Only a typed A2A call, which
 * the caller composed itself, isn't held.
 */
export async function heldToDraft(confirmed: Confirmed | undefined, f: Flow) {
  if (confirmed === 'direct') return;
  const held = confirmed?.bound?.draft;
  if (typeof held !== 'string' || held !== (await draftHash(f))) throw new Refused(DRAFT_CHANGED);
}

export async function previewTestFlow(
  env: Env,
  flowId: string,
  roleBlock?: string,
): Promise<ActionPreview> {
  const t = await testPlan(env, flowId);
  const next = (t.row.publishedVersion ?? 0) + 1;
  return {
    title: `Test ${t.row.name}`,
    href: `/flows/${t.row.id}`,
    consequences: [
      t.publishes
        ? `Publishes the saved draft as v${next} first (${t.diff ?? 'no changes'}): new orders run it`
        : `Runs v${t.row.publishedVersion}, the live version; nothing is published`,
      t.sample
        ? `Starts an order with the “${t.sample.label}” demo input`
        : 'Starts an empty order on it',
      'The order runs for real: its payment, stock and shipping steps act',
    ],
    bound: { draft: await draftHash(t.flow) },
    blocked:
      roleBlock ??
      (t.row.archivedAt ? 'The flow is archived. Restore it first.' : undefined) ??
      (t.publishes && t.errors.length
        ? `The draft has ${t.errors.length} problem${t.errors.length === 1 ? '' : 's'} to fix first: ${t.errors[0]!.message}`
        : undefined),
  };
}

export async function runTestFlow(
  env: Env,
  p: Principal,
  flowId: string,
  key: string | undefined,
  trail: Trail,
  confirmed?: Confirmed,
) {
  const t = await testPlan(env, flowId);
  await heldToDraft(confirmed, t.flow);
  if (t.publishes && t.errors.length) throw new Refused('The draft has problems to fix first.');
  let version = t.row.publishedVersion!;
  if (t.publishes) {
    version = await publishFlow(createDb(env.DB), t.flow, Date.now(), {
      publishedBy: p.email ?? p.name,
    });
    await recordAudit(env, 'flow.published', {
      actor: p,
      target: t.flow.id,
      detail: { name: t.flow.name, version, ...trail },
    });
  }
  const result = await startOrderOnce(env, {
    flowId: t.flow.id,
    version,
    input: t.sample?.input ?? {
      model: t.flow.model,
      channel: 'manual',
      currency: 'USD',
      lines: [],
      meta: {},
    },
    startedBy: p.id,
    idempotencyKey: `assistant:${p.id}:${key ?? crypto.randomUUID()}`,
  });
  if ('mismatch' in result) throw new Refused('This confirm already started a different order.');
  if (!result.replayed)
    await recordAudit(env, 'order.started', {
      actor: p,
      target: result.orderId,
      detail: { flowId: t.flow.id, version, test: true, ...trail },
    });
  return {
    done: `Started test order ${orderRef(result.orderId)} on v${version}`,
    href: `/orders/${result.orderId}`,
    orderId: result.orderId,
    version,
  };
}
