/**
 * The plugin contract as checks a plugin's own tests run against it (in workerd or Node; it needs
 * no bindings). `pluginContract` returns what is wrong, empty when nothing is:
 *
 *   expect(await pluginContract(plugin, cases)).toEqual([]);
 *
 * It checks what the engine relies on and can't check at run time: the manifest parses for this
 * contract version; running a node twice for the same order and step key gives the same result and
 * no second effect; undoing it twice is harmless and leaves what was there before; delivering the
 * same event twice records it once; a provider's results have its surface's shape, rates, tax
 * and address checks write nothing (they also run while pricing a checkout), and a label created
 * twice for one key is created once and voided twice harmlessly; and a page refuses a request
 * without a signed-in person, or from one below the manifest's `pageRole`.
 */

import {
  checkProvideResult,
  type Order,
  type OutboundPayload,
  type PluginManifest,
  type PluginRpc,
  PRINCIPAL_HEADER,
  type ProvideRequest,
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

/** A ship-to for providers granted buyer details. */
const SHIP_TO = {
  name: 'Contract Buyer',
  line1: '1 Main St',
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
};

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

  for (const surface of manifest.provides) {
    const orderId = `ord_contract_${surface.replace(/\W/g, '_')}`;
    const order = {
      ...(cases.order ?? BASE_ORDER),
      id: orderId,
      ...(manifest.personalData === 'send'
        ? { meta: { ...(cases.order ?? BASE_ORDER).meta, shipTo: SHIP_TO } }
        : {}),
    };
    const base = { nodeId: 'contract', stepKey: 'contract#1', orderId, config: {}, order };
    const call = async (req: ProvideRequest) => {
      const out = checkProvideResult(manifest.id, req.surface, req.op, await stub.provide(req));
      if (out.kind === 'fail') throw new Error(`${req.op} failed (${out.message})`);
      return out.value;
    };
    try {
      const before = await cases.effects(orderId);
      if (surface === 'shipping.labels') {
        const create: ProvideRequest = {
          ...base,
          surface,
          op: 'create',
          input: {
            kind: 'shipment',
            carrier: 'ups',
            packages: [{ ref: 'p1', locationId: null, lines: [{ sku: 'SKU-1', qty: 1 }] }],
          },
        };
        type Labels = { labels: { ref: string; id: string }[] };
        const first = (await call(create)) as Labels;
        const afterFirst = await cases.effects(orderId);
        if (afterFirst <= before)
          problems.push(`${surface}: create wrote nothing the effects() probe sees`);
        if (!first.labels.some((l) => l.ref === 'p1'))
          problems.push(`${surface}: create returned no label for package p1`);
        const second = await call(create);
        if (!same(first, second))
          problems.push(
            `${surface}: create gave a different result when run again for the same step`,
          );
        if ((await cases.effects(orderId)) !== afterFirst)
          problems.push(`${surface}: create wrote again for the same order and step key`);
        const labels = first.labels.map(({ ref, id }) => ({ ref, id }));
        const { order: _order, ...noOrder } = base;
        const undo: ProvideRequest = { ...noOrder, surface, op: 'void', input: { labels } };
        await call(undo);
        await call(undo);
        const afterVoid = await cases.effects(orderId);
        if (afterVoid !== before)
          problems.push(
            `${surface}: voiding twice left ${afterVoid} effects; there were ${before} before create`,
          );
      } else {
        const req: ProvideRequest =
          surface === 'shipping.rates'
            ? ({
                ...base,
                surface,
                op: 'quote',
                input: { itemCount: 1, country: 'US', subtotal: 10, currency: 'USD' },
              } as const)
            : surface === 'tax'
              ? ({
                  ...base,
                  surface,
                  op: 'calculate',
                  input: { subtotal: 10, shipping: 5, includeShipping: true, currency: 'USD' },
                } as const)
              : ({ ...base, surface, op: 'validate', input: { address: SHIP_TO } } as const);
        await call(req);
        if ((await cases.effects(orderId)) !== before)
          problems.push(
            `${surface}: ${req.op} wrote something; it also runs while pricing checkouts, so it must not`,
          );
      }
    } catch (err) {
      problems.push(`${surface}: ${message(err)}`);
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
