/**
 * Before a plugin is removed from a deployment: lists the published flows and running orders that
 * still use its nodes, through the deployment's REST API, and fails if there are any. See
 * docs/plugins.md, "Removing a plugin".
 *
 *   ORDERLOOP_API_TOKEN=ol_… node scripts/plugin-check.ts <deployment id> <plugin id>
 *
 * The token must be an admin's (Settings → API tokens on that deployment).
 */

import { loadDeployments } from './fleet.ts';

type Usage = {
  flows: { id: string; version: number }[];
  orders: { id: string; flowId: string; version: number }[];
  labels: { id: string; orderId: string }[];
};

const [id, plugin] = process.argv.slice(2);
try {
  if (!id || !plugin) throw new Error('usage: plugin-check.ts <deployment id> <plugin id>');
  const token = process.env.ORDERLOOP_API_TOKEN;
  if (!token) throw new Error("ORDERLOOP_API_TOKEN not set: use an admin's API token");
  const d = loadDeployments().find((x) => x.id === id);
  if (!d) throw new Error(`no deployment ${JSON.stringify(id)} in deployments/`);
  const res = await fetch(`https://${d.domain}/api/v1/plugins/${plugin}/usage`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${d.domain} answered ${res.status}: ${await res.text()}`);
  const usage = (await res.json()) as Usage;
  for (const f of usage.flows) console.log(`flow   ${f.id} (published v${f.version})`);
  for (const o of usage.orders)
    console.log(`order  ${o.id} (running on ${o.flowId} v${o.version})`);
  for (const l of usage.labels) console.log(`label  ${l.id} (order ${l.orderId}, not voided yet)`);
  if (usage.flows.length || usage.orders.length || usage.labels.length) {
    console.error(
      `${plugin} is still used on ${d.id}: republish those flows without its nodes and let the orders finish (or cancel them) first; labels it couldn't void are retried daily`,
    );
    process.exit(1);
  }
  console.log(
    `Nothing on ${d.id} uses ${plugin}: it can be removed from deployments/${d.id}.jsonc`,
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
