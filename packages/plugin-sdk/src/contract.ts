/**
 * The plugin contract as checks a plugin's own tests run against it (in workerd or Node; it needs
 * no bindings). `pluginContract` returns what is wrong, empty when nothing is:
 *
 *   expect(await pluginContract(plugin, cases)).toEqual([]);
 *
 * It checks what the engine relies on and can't check at run time: the manifest parses for this
 * contract version; running a node twice for the same order and step key gives the same result and
 * no second effect; undoing it twice is harmless and leaves what was there before; delivering the
 * same event twice records it once; and a page refuses a request without a signed-in person, or
 * from one below the manifest's `pageRole`.
 */

import {
  type Order,
  type OutboundPayload,
  type PluginManifest,
  type PluginRpc,
  PRINCIPAL_HEADER,
  parseManifest,
  ROLES,
  signPrincipal,
  withPlugins,
} from '@orderloop/core';

export type ContractStub = PluginRpc & { fetch(request: Request): Promise<Response> };

export type ContractCases = {
  /**
   * Counts the plugin's effects for an order (its rows for that order, say). The suite compares the
   * count around repeated calls, so it must see every write a node or compensation makes.
   */
  effects(orderId: string): Promise<number>;
  /** Config to run each node with, by node type; its fields' defaults are filled in, as the engine does. */
  configs?: Record<string, Record<string, unknown>>;
  /**
   * Node types that write nothing (they only compute or call out). Every other node must write at
   * least one effect for its config, so the suite knows its idempotency checks saw a real write.
   */
  noEffects?: string[];
  /** The order nodes are run for; a small B2B order by default. Its id is replaced per node. */
  order?: Order;
  /** Counts what the plugin recorded for a delivery id; needed when the manifest has events. */
  deliveries?(payloadId: string): Promise<number>;
  /** The key the plugin verifies page requests with (its `PLUGIN_KEY`); needed when it has pages. */
  principalKey?: string;
  /** A signed-in page to probe; defaults to the first nav path. */
  pagePath?: string;
};

const BASE_ORDER: Order = {
  id: 'ord_contract',
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  lines: [{ sku: 'SKU-1', name: 'Item', qty: 1, unitPrice: 10 }],
  meta: {},
  createdAt: 0,
  subtotal: 10,
  shipping: 0,
  tax: 0,
  total: 10,
} as Order;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function pluginContract(stub: ContractStub, cases: ContractCases): Promise<string[]> {
  const problems: string[] = [];
  let manifest: PluginManifest;
  try {
    manifest = parseManifest(await stub.manifest());
  } catch (err) {
    return [`manifest: ${message(err)}`];
  }

  const registry = withPlugins([manifest]);
  for (const n of manifest.nodes) {
    const orderId = `ord_contract_${n.type.replace(/\W/g, '_')}`;
    const writes = !cases.noEffects?.includes(n.type);
    const req = {
      type: n.type,
      nodeId: 'contract',
      stepKey: 'contract#1',
      orderId,
      config: registry.withDefaults(n.type, cases.configs?.[n.type] ?? {}),
      order: { ...(cases.order ?? BASE_ORDER), id: orderId },
      vars: {},
      nodes: {},
    };
    try {
      const before = await cases.effects(orderId);
      const first = await stub.execute(req);
      if ('fail' in first) {
        problems.push(
          `${n.type}: execute failed (${first.fail.message}); give it a config that succeeds in configs`,
        );
        continue;
      }
      const afterFirst = await cases.effects(orderId);
      if (writes && afterFirst <= before)
        problems.push(
          `${n.type}: execute wrote nothing the effects() probe sees; list it in noEffects if it writes nothing`,
        );
      const second = await stub.execute(req);
      const afterSecond = await cases.effects(orderId);
      if (!same(first, second))
        problems.push(
          `${n.type}: execute gave a different result when run again for the same step`,
        );
      if (afterSecond !== afterFirst)
        problems.push(
          `${n.type}: execute wrote again for the same order and step key (${afterFirst} → ${afterSecond} effects)`,
        );
      // Another run of the node (a loop's next iteration, the next generation) must write again.
      if (writes && afterFirst > before) {
        await stub.execute({ ...req, stepKey: 'contract#2' });
        const afterOther = await cases.effects(orderId);
        if (afterOther <= afterSecond)
          problems.push(
            `${n.type}: a run with another step key wrote nothing; key writes by order id and step key, not the order alone`,
          );
        await stub.compensate({ ...req, stepKey: 'contract#2', output: undefined });
      }
      if (n.rollback) {
        const output = first.output;
        const undo = { type: n.type, nodeId: 'contract', stepKey: 'contract#1', orderId, output };
        await stub.compensate(undo);
        await stub.compensate(undo);
        const afterUndo = await cases.effects(orderId);
        if (afterUndo !== before)
          problems.push(
            `${n.type}: compensating twice left ${afterUndo} effects; there were ${before} before execute`,
          );
      }
    } catch (err) {
      problems.push(`${n.type}: ${message(err)}`);
    }
  }

  const event =
    manifest.events.find((e) => e !== '*') ?? (manifest.events.length ? 'order.completed' : null);
  if (event) {
    if (!cases.deliveries) problems.push('events: pass deliveries() to check redelivery');
    else {
      const payload: OutboundPayload = {
        id: 'whd_contract_1',
        event: event as OutboundPayload['event'],
        occurredAt: 0,
        orderId: 'ord_contract_events',
        data: {},
      };
      try {
        await stub.deliver(payload);
        await stub.deliver(payload);
        const n = await cases.deliveries(payload.id);
        if (n !== 1) problems.push(`events: delivering ${payload.id} twice recorded it ${n} times`);
      } catch (err) {
        problems.push(`events: ${message(err)}`);
      }
    }
  }

  const page = cases.pagePath ?? manifest.nav[0]?.path;
  if (page) {
    const get = (headers: Record<string, string> = {}) =>
      stub.fetch(new Request(`https://plugin${page}`, { headers }));
    const signed = async (key: string, role: (typeof ROLES)[number]) => {
      const p = { kind: 'user' as const, id: 'usr_contract', name: 'Contract', role };
      return { [PRINCIPAL_HEADER]: await signPrincipal(key, p, page) };
    };
    const anonymous = await get();
    if (anonymous.status !== 401)
      problems.push(
        `pages: ${page} answered ${anonymous.status} without a signed-in person, not 401`,
      );
    if (!cases.principalKey) problems.push('pages: pass principalKey to check roles');
    else {
      const below = ROLES[ROLES.indexOf(manifest.pageRole) - 1];
      if (below) {
        const res = await get(await signed(cases.principalKey, below));
        if (res.status !== 403)
          problems.push(`pages: ${page} answered ${res.status} to the role ${below}, not 403`);
      }
      const ok = await get(await signed(cases.principalKey, manifest.pageRole));
      if (ok.status === 401 || ok.status === 403)
        problems.push(`pages: ${page} refused the role ${manifest.pageRole} (${ok.status})`);
    }
  }

  return problems;
}
