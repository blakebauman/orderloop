/**
 * Plugins: optional features a deployment installs as their own Worker, bound to the engine and the
 * web app as `PLUGIN_<ID>`. A plugin owns its storage and reaches OrderLoop only through this
 * contract, so removing it (from the deployment registry, then its Worker and database) leaves the
 * core as it was. See docs/plugins.md.
 *
 * A plugin contributes node types (namespaced `<id>.<name>`, run by the engine inside the node's
 * own step), subscribes to outbound events (delivered over the binding instead of HTTP) and serves
 * pages under `/plugins/<id>/`. Its manifest is plain JSON, so node specs are the serialisable
 * subset of `NodeSpec`: fixed outputs and JSON Schema in place of zod.
 */

import { z } from 'zod';
import {
  type ConfigField,
  type NodeCategory,
  type NodeSpec,
  nodeOutputs,
  nodeProvider,
  nodeSpec,
  PROVIDER_SURFACE_LABELS,
  PROVIDER_SURFACES,
  type ProviderSurface,
  specDefaults,
  validateFields,
} from './catalog';
import { conforms } from './json-schema';
import type { CartReturn, CartReturnRequest } from './plugin-host';
import { maskPersonalText, modelOrder, PERSONAL_DATA_MODES, scrubPersonal } from './redact';
import { ROLES } from './roles';
import type { Order } from './types';
import { OUTBOUND_EVENTS, type OutboundPayload } from './webhooks';

/** Node type prefixes the built-in catalog uses; no plugin may take one as its id. */
/**
 * Ids no plugin may take: the built-in catalog's type prefixes, and those whose binding name would
 * be one of the engine's own plugin variables (`PLUGIN_BUNDLES`, `PLUGIN_SECRETS`, `PLUGIN_GRANTS`,
 * `PLUGIN_KEY`).
 */
const RESERVED_IDS = new Set([
  'trigger',
  'commerce',
  'control',
  'ai',
  'core',
  'orderloop',
  'bundles',
  'secrets',
  'grants',
  'key',
  'storage',
  'dev-bundles',
  'publishers',
]);

/**
 * How a deployment runs a plugin: `worker` is its own Worker, bound as `PLUGIN_<ID>`; `sandboxed`
 * is a Dynamic Worker the engine loads (Worker Loader), with no bindings of its own, its outbound
 * requests through the engine's egress gateway and its CPU and subrequests capped per call.
 */
/**
 * What a plugin may ask the core to do through its host binding (`ORDERLOOP`, `PluginHostRpc`):
 * open external carts for buyers it has authenticated (`carts:external`), start orders
 * (`orders:start`), and cancel the orders it started (`orders:cancel`, apart from starting so a
 * plugin that only places orders can't also call them off). A manifest declares them; each takes
 * effect only with the deployment's grant (`plugins.<id>.capabilities` in its registry), as buyer
 * details do.
 */
export const PLUGIN_CAPABILITIES = ['carts:external', 'orders:start', 'orders:cancel'] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** What each capability lets a plugin do, as the Plugins page says it. */
export const PLUGIN_CAPABILITY_LABELS: Record<PluginCapability, string> = {
  'carts:external': 'Opens carts for outside buyers',
  'orders:start': 'Starts orders',
  'orders:cancel': 'Cancels the orders it started',
};

export const PLUGIN_RUNTIMES = ['worker', 'sandboxed'] as const;
export type PluginRuntime = (typeof PLUGIN_RUNTIMES)[number];

/** The most a sandboxed plugin may use per call, by what the call is for; the defaults are these. */
export const PLUGIN_LIMIT_CAPS = {
  /** A node, a provider op or a compensation, inside an order's step. */
  call: { cpuMs: 200, subRequests: 20 },
  /** A page or an event delivery. */
  serve: { cpuMs: 1000, subRequests: 20 },
} as const;

/** An egress host: a DNS name, or `*.` and one (which also matches the name itself). */
const EGRESS_HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Whether `host` is one of the manifest's `egress` entries. */
export function egressAllows(egress: readonly string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return egress.some((e) =>
    e.startsWith('*.') ? h === e.slice(2) || h.endsWith(e.slice(1)) : h === e,
  );
}

/** Lower case, digits and single dashes inside: "qbd-sync", never "a--b" or "a-". */
export const PLUGIN_ID_RE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/;

/**
 * The contract version this OrderLoop speaks. A manifest declares the one it was written for, and
 * one for any other version is refused rather than half understood.
 */
export const PLUGIN_API_VERSION = 1;

/** Longest summary a plugin node may report for the order's timeline. */
export const PLUGIN_SUMMARY_MAX = 300;

/** Largest `output` (and, separately, `vars`) a plugin node may return, serialized. */
export const PLUGIN_RESULT_MAX_BYTES = 128 * 1024;

/** Largest manifest the engine accepts, serialized. */
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;

/** A nav or public path: plain characters only, so a link can't lead outside the plugin. */
const PLUGIN_PAGE_PATH_RE = /^\/plugins\/[a-z][a-z0-9-]{1,30}\/[A-Za-z0-9._~/-]*$/;

/**
 * The surfaces whose work needs the buyer's address (a label's ship-to, tax by jurisdiction, the
 * address itself), so a plugin providing them must ask for buyer details, and be granted them.
 * Rates get the ship-to country only, as a redacted order has it.
 */
export const SURFACE_NEEDS_BUYER: Record<ProviderSurface, boolean> = {
  'shipping.rates': false,
  'shipping.labels': true,
  tax: true,
  address: true,
};

/**
 * The key the web app signs a plugin's page requests with, and the only one the plugin holds: an
 * HMAC of the deployment's principal key with the plugin's id. The engine and other plugins never
 * accept it, so a plugin can't sign requests to them; scripts/fleet.ts derives the same value for
 * the plugin's secrets. A plugin an admin installed at runtime holds its version's own key
 * (`install`, the bundle's sha): one that leaked opens nothing for any other version, so it stops
 * working once another version runs or the plugin is removed (until that same bundle runs again).
 */
export async function pluginKey(
  principalKey: string,
  id: string,
  install?: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(principalKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // Anything but a bundle's sha is refused, never read as "no install" (the registry's key).
  if (install !== undefined && !/^[0-9a-f]{64}$/.test(install))
    throw new Error(`pluginKey: ${id}'s install must be its bundle's sha`);
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(install ? `orderloop-plugin:${id}@${install}` : `orderloop-plugin:${id}`),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The binding a plugin is reached by: "ledger" → "PLUGIN_LEDGER", "qbd-sync" → "PLUGIN_QBD_SYNC". */
export const pluginBinding = (id: string) => `PLUGIN_${id.toUpperCase().replace(/-/g, '_')}`;

/** A secret's name in the plugin's env: upper case, digits and underscores. */
export const PLUGIN_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,62}$/;

/** Names a plugin's env already has from the deployment, which no secret may take. */
export const RESERVED_PLUGIN_ENV = new Set([
  'PLUGIN_KEY',
  'PLUGIN_KEY_PREVIOUS',
  'DB',
  // The sandbox's capabilities (`secret()` and `pluginDb()` in @orderloop/plugin-sdk).
  'SECRETS',
  'STORAGE',
]);

/**
 * Where a deployment keeps one of a plugin's secrets: in its GitHub environment, named by the
 * plugin's binding and the secret ("shipstation", "API_KEY" → "PLUGIN_SHIPSTATION_API_KEY"). The
 * deploy hands the plugin's Worker only the ones with its prefix, under their own names.
 */
export const pluginSecretVar = (id: string, name: string) => `${pluginBinding(id)}_${name}`;

/** The plugin a node type belongs to, or null for a built-in type. */
export function pluginOf(type: string): string | null {
  const dot = type.indexOf('.');
  if (dot < 1) return null;
  const ns = type.slice(0, dot);
  return RESERVED_IDS.has(ns) ? null : ns;
}

const pluginId = z
  .string()
  .regex(PLUGIN_ID_RE, 'Use 2–31 lowercase letters, digits and hyphens, starting with a letter')
  .refine((id) => !RESERVED_IDS.has(id), 'That id is reserved');

const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum([
    'text',
    'textarea',
    'number',
    'boolean',
    'select',
    'duration',
    'logic',
    'json',
    'list',
  ]),
  hint: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  /** Validates a `json` field's value, in place of the zod schema a built-in field can carry. */
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
});

export type PluginField = z.infer<typeof fieldSchema>;

const nodeSchema = z.object({
  type: z.string(),
  /** Plugin nodes run in one step: no triggers, and no waiting or looping (the interpreter's own). */
  category: z.enum(['commerce', 'control', 'ai']),
  label: z.string().min(1),
  description: z.string(),
  /** lucide-react icon name. */
  icon: z.string().min(1),
  fields: z.array(fieldSchema).max(50),
  outputs: z.array(z.string().min(1)).min(1),
  /** The plugin's `compensate` runs for this node when the order fails after it. */
  rollback: z.boolean().optional(),
  retries: z.number().int().min(0).max(10).optional(),
});

export type PluginNodeSpec = z.infer<typeof nodeSchema>;

export const pluginManifestSchema = z
  .object({
    /** Must be `PLUGIN_API_VERSION`. */
    apiVersion: z.literal(PLUGIN_API_VERSION, {
      error: `apiVersion must be ${PLUGIN_API_VERSION}, the plugin contract this OrderLoop speaks`,
    }),
    id: pluginId,
    name: z.string().min(1),
    /** Changes whenever the manifest does; the engine caches manifests by it. */
    version: z.string().min(1),
    nodes: z.array(nodeSchema).max(50).default([]),
    /** Outbound events delivered to the plugin's `deliver`; "*" for every one. */
    events: z.array(z.enum(['*', ...OUTBOUND_EVENTS])).default([]),
    /** Sidebar entries; each path is under the plugin's own `/plugins/<id>/`. */
    nav: z
      .array(z.object({ label: z.string().min(1), path: z.string(), icon: z.string().min(1) }))
      .default([]),
    /**
     * Paths under `/plugins/<id>/` the web app forwards with no signed-in person, for callers that
     * authenticate to the plugin themselves (another system's connector, a webhook).
     */
    publicPaths: z.array(z.string()).default([]),
    /** Plugins that must be installed alongside this one. */
    requires: z.array(pluginId).default([]),
    /** The least role a person needs to open the plugin's pages (and see its nav entries). */
    pageRole: z.enum(ROLES).default('operator'),
    /**
     * Whether `execute` sees who the buyer is. `redact` (the default) scrubs contact details, names
     * and addresses from the order, variables and earlier outputs it is sent, as AI nodes get them.
     */
    personalData: z.enum(PERSONAL_DATA_MODES).default('redact'),
    /**
     * Secrets the plugin reads from its env (an outside service's API key, a webhook signing
     * secret), set per deployment as `pluginSecretVar(id, name)`. Until each one not `optional` is
     * set, the plugin's manifest call fails, so the plugin counts as not installed.
     */
    secrets: z
      .array(
        z.object({
          name: z
            .string()
            .regex(PLUGIN_SECRET_NAME_RE, 'Use upper-case letters, digits and underscores'),
          description: z.string().max(200).optional(),
          optional: z.boolean().optional(),
          /**
           * Sandboxed plugins: the egress gateway adds the secret to requests to `host` as `header`
           * (`format` with `{}` for the value), and the plugin itself never sees it.
           */
          inject: z
            .object({
              // An exact host: a credential never goes to every subdomain of a shared suffix.
              host: z
                .string()
                .regex(EGRESS_HOST_RE, 'A host name')
                .refine((h) => !h.startsWith('*.'), { message: 'Inject into one exact host' }),
              header: z
                .string()
                .regex(/^[A-Za-z0-9-]{1,64}$/, 'A header name')
                .refine((h) => !['host', 'cookie', 'content-length'].includes(h.toLowerCase()), {
                  message: 'That header is not allowed',
                }),
              format: z
                .string()
                .max(200)
                .includes('{}', { message: 'Put {} where the value goes' }),
            })
            .optional(),
          /** Sandboxed plugins: readable by the plugin's code (`secret()`), e.g. to verify a signature. */
          expose: z.boolean().optional(),
        }),
      )
      .max(20)
      .default([]),
    /**
     * What the plugin can do behind built-in nodes (`PROVIDER_SURFACES`): a flow picks it in a
     * node's Provider field, and the engine calls `provide` instead of the built-in connector.
     */
    provides: z.array(z.enum(PROVIDER_SURFACES)).default([]),
    /** What it asks the core to do through `ORDERLOOP` (`PLUGIN_CAPABILITIES`), each granted per deployment. */
    capabilities: z
      .array(z.enum(PLUGIN_CAPABILITIES))
      .default([])
      .refine((c) => new Set(c).size === c.length, 'Each capability once'),
    /**
     * Hosts a sandboxed plugin may reach (a name, or `*.` and one); anything else is refused by
     * the engine's egress gateway, as are private and internal addresses whatever this says.
     */
    egress: z
      .array(z.string().regex(EGRESS_HOST_RE, 'A host name, or *. and one'))
      .max(20)
      .default([]),
    /** What a sandboxed plugin may use per call, at most `PLUGIN_LIMIT_CAPS`. */
    limits: z
      .object({
        cpuMs: z.number().int().positive().max(PLUGIN_LIMIT_CAPS.serve.cpuMs).optional(),
        subRequests: z.number().int().min(0).max(PLUGIN_LIMIT_CAPS.serve.subRequests).optional(),
      })
      .default({}),
  })
  .superRefine((m, ctx) => {
    const prefix = `/plugins/${m.id}/`;
    const seen = new Set<string>();
    for (const [i, n] of m.nodes.entries()) {
      const name = n.type.slice(m.id.length + 1);
      if (!n.type.startsWith(`${m.id}.`) || !/^[a-z][a-z0-9_]*$/.test(name))
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', i, 'type'],
          message: `Node types must be “${m.id}.<name>” (lowercase, digits, underscores)`,
        });
      if (seen.has(n.type))
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'type'], message: 'Duplicate type' });
      seen.add(n.type);
    }
    const names = new Set<string>();
    for (const [i, { name }] of m.secrets.entries()) {
      if (RESERVED_PLUGIN_ENV.has(name) || names.has(name))
        ctx.addIssue({
          code: 'custom',
          path: ['secrets', i, 'name'],
          message: RESERVED_PLUGIN_ENV.has(name) ? 'That name is reserved' : 'Duplicate secret',
        });
      names.add(name);
    }
    for (const [i, x] of m.secrets.entries()) {
      if (x.inject && x.expose)
        ctx.addIssue({
          code: 'custom',
          path: ['secrets', i],
          message: 'A secret is either injected or exposed, not both',
        });
      if (x.inject && !egressAllows(m.egress, x.inject.host))
        ctx.addIssue({
          code: 'custom',
          path: ['secrets', i, 'inject', 'host'],
          message: 'Inject only into a host in egress',
        });
    }
    for (const [i, surface] of m.provides.entries()) {
      if (m.provides.indexOf(surface) !== i)
        ctx.addIssue({ code: 'custom', path: ['provides', i], message: 'Duplicate surface' });
      if (SURFACE_NEEDS_BUYER[surface] && m.personalData !== 'send')
        ctx.addIssue({
          code: 'custom',
          path: ['provides', i],
          message: `Providing ${PROVIDER_SURFACE_LABELS[surface].toLowerCase()} needs the buyer's address: set personalData to "send"`,
        });
    }
    for (const [key, paths] of [
      ['nav', m.nav.map((n) => n.path)],
      ['publicPaths', m.publicPaths],
    ] as const)
      for (const [i, p] of paths.entries())
        if (!p.startsWith(prefix) || !PLUGIN_PAGE_PATH_RE.test(p) || /(^|\/)\.\.?(\/|$)/.test(p))
          ctx.addIssue({
            code: 'custom',
            path: [key, i],
            message: `Must be a plain path under ${prefix} (letters, digits, - _ . ~ /, no . or .. segments)`,
          });
    let bytes = 0;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(m)).byteLength;
    } catch {}
    if (bytes > PLUGIN_MANIFEST_MAX_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: `The manifest is ${bytes} bytes; the limit is ${PLUGIN_MANIFEST_MAX_BYTES}`,
      });
  });

export type PluginManifest = z.output<typeof pluginManifestSchema>;

/** Parses a manifest a plugin returned, with its problems as one readable error. */
export function parseManifest(value: unknown): PluginManifest {
  const r = pluginManifestSchema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new Error(
    `Invalid plugin manifest: ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
  );
}

/** What the engine sends a plugin to run one of its nodes, inside that node's step. */
export type PluginExecRequest = {
  type: string;
  nodeId: string;
  /**
   * The node's effect key, unique within the order: key every write for this run by `orderId` and
   * `stepKey` together, so a retried step writes once.
   */
  stepKey: string;
  orderId: string;
  /** The node's config with defaults filled in, expressions not yet evaluated. */
  config: Record<string, unknown>;
  /** The whole order with `personalData: 'send'`; otherwise `RedactedOrder` (see `pluginOrder`). */
  order: Order | RedactedOrder;
  vars: Record<string, unknown>;
  /** Earlier nodes' outputs, by node id. */
  nodes: Record<string, unknown>;
};

/**
 * What `execute` returns: the branch it took, or `fail` to fail the node. `fail` with `retry: false`
 * fails it for good (a declined request, bad config); with `retry: true` the step is tried again,
 * as when `execute` throws.
 */
export type PluginExecResult =
  | {
      /** One of the node's `outputs`; defaults to the first. */
      branch?: string;
      output?: unknown;
      /** One line for the order's timeline, at most `PLUGIN_SUMMARY_MAX` characters. */
      summary?: string;
      /** Merged into the order's variables under the plugin's id: `vars.<id>`. */
      vars?: Record<string, unknown>;
    }
  | { fail: { message: string; retry?: boolean } };

const jsonSized = (what: string) =>
  z.unknown().superRefine((v, ctx) => {
    let bytes: number;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(v ?? null)).byteLength;
    } catch {
      ctx.addIssue({ code: 'custom', message: `${what} must be JSON` });
      return;
    }
    if (bytes > PLUGIN_RESULT_MAX_BYTES)
      ctx.addIssue({
        code: 'custom',
        message: `${what} is ${bytes} bytes; the limit is ${PLUGIN_RESULT_MAX_BYTES}`,
      });
  });

/** Long text is cut, not refused: a long upstream error must not turn a retry into a failure. */
const clip = (s: string) =>
  s.length > PLUGIN_SUMMARY_MAX ? `${s.slice(0, PLUGIN_SUMMARY_MAX - 1)}…` : s;

const failSchema = z.object({
  fail: z.object({
    message: z.string().min(1).transform(clip),
    retry: z.boolean().optional(),
  }),
});

const doneSchema = z.object({
  branch: z.string().optional(),
  output: jsonSized('output').optional(),
  summary: z.string().transform(clip).optional(),
  vars: z.record(z.string(), z.unknown()).and(jsonSized('vars')).optional(),
});

/** A checked `execute` result: what the node did, or how it failed. */
export type PluginOutcome =
  | {
      kind: 'done';
      branch: string;
      output?: unknown;
      summary?: string;
      vars?: Record<string, unknown>;
    }
  | { kind: 'fail'; message: string; retry: boolean };

/**
 * Checks what a plugin returned for a node with these `outputs`. Throws (with a message naming the
 * problem) for a result the engine must not apply: not the contract's shape, too large, or a
 * branch the node doesn't have.
 */
export function checkExecResult(type: string, value: unknown, outputs: string[]): PluginOutcome {
  const raw = value ?? {};
  const failing = !!raw && typeof raw === 'object' && 'fail' in raw;
  const r = (failing ? failSchema : doneSchema).safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(
      `${type} returned an invalid result: ${issue?.path.join('.') || 'result'}: ${issue?.message}`,
    );
  }
  if ('fail' in r.data)
    return { kind: 'fail', message: r.data.fail.message, retry: r.data.fail.retry === true };
  const branch = r.data.branch ?? outputs[0]!;
  if (!outputs.includes(branch))
    throw new Error(`${type} chose “${branch}”, which isn't one of its outputs`);
  return {
    kind: 'done',
    branch,
    output: r.data.output,
    summary: r.data.summary,
    vars: r.data.vars,
  };
}

type Privacy = Pick<PluginManifest, 'personalData'>;

/** Variables or earlier outputs as a plugin with this manifest is sent them. */
export function pluginView<T>(manifest: Privacy, value: T): T {
  return manifest.personalData === 'send' ? value : (scrubPersonal(value) as T);
}

/** The order as a plugin that hasn't been granted buyer details sees it. */
export type RedactedOrder = ReturnType<typeof modelOrder> & {
  externalId?: string;
  createdAt: number;
};

/**
 * The order as a plugin with this manifest is sent it. Redacted, it is built from an allowlist of
 * commercial facts, as AI nodes get it: lines (with product names), amounts, currency, channel,
 * fulfilment method and ship-to country; the title with emails and phone numbers masked. It has no
 * contact, addresses, `meta`, inbound document text or payment ids.
 */
export function pluginOrder(manifest: Privacy, order: Order): Order | RedactedOrder {
  if (manifest.personalData === 'send') return order;
  const { meta: _meta, ...facts } = modelOrder(order, 'redact');
  return {
    ...facts,
    title: order.title ? maskPersonalText(order.title) : undefined,
    externalId: order.externalId,
    createdAt: order.createdAt,
  } as RedactedOrder;
}

export type PluginCompensateRequest = {
  type: string;
  nodeId: string;
  stepKey: string;
  orderId: string;
  /** What `execute` returned as `output` for this run, when it got that far. */
  output: unknown;
};

// ── Providers ────────────────────────────────────────────────────────────────

/** A package to label: one per location the order ships from (`ref` names it in the result). */
export type LabelPackage = {
  ref: string;
  locationId: string | null;
  lines: { sku: string; qty: number }[];
};

/**
 * What the engine asks a provider, inside the node's step (or, for rates and tax, while pricing a
 * checkout, with `stepKey` `quote#<nodeId>`). Amounts are in the order's currency, except a rate
 * request's `subtotal` and the rates returned, which are in `BASE_CURRENCY` as static rates are.
 * Key every write by `orderId` and `stepKey` together, as a node's.
 */
export type ProvideRequest = {
  nodeId: string;
  stepKey: string;
  orderId: string;
  /** The node's config with defaults filled in. */
  config: Record<string, unknown>;
} & (
  | {
      surface: 'shipping.rates';
      op: 'quote';
      order: Order | RedactedOrder;
      input: {
        itemCount: number;
        /** Total billable kg, when the node's basis weighs units (`weight` or `dim_weight`). */
        billableKg?: number;
        country?: string;
        subtotal: number;
        currency: string;
      };
    }
  | {
      surface: 'shipping.labels';
      op: 'create';
      order: Order | RedactedOrder;
      input: { kind: 'shipment' | 'return'; carrier: string; packages: LabelPackage[] };
    }
  | {
      surface: 'shipping.labels';
      op: 'void';
      /**
       * Labels `create` returned, to void: on a rollback (`stepKey` is the creating step's) or when
       * the order is cancelled (`stepKey` "cancel"). Key it by the label ids: it may run again.
       */
      input: { labels: { ref: string; id: string }[] };
    }
  | {
      surface: 'tax';
      op: 'calculate';
      order: Order | RedactedOrder;
      input: { subtotal: number; shipping: number; includeShipping: boolean; currency: string };
    }
  | {
      surface: 'address';
      op: 'validate';
      order: Order | RedactedOrder;
      input: { address: unknown };
    }
);

export type ProvideOp = ProvideRequest['op'];

const shortText = (max: number) => z.string().min(1).max(max);

/**
 * Text a provider returns that the engine stores and shows (tracking, carrier, label ids):
 * printable, with no control or bidi characters, since it reaches the timeline, webhooks and UCP
 * events.
 */
const plainText = (max: number) =>
  shortText(max).regex(/^[A-Za-z0-9 ._:#+-]+$/, 'Use letters, digits, spaces and . _ : # + -');

/** The most tax a provider may charge, as a share of what is taxable; more fails the node. */
export const PROVIDER_MAX_TAX_RATE = 0.5;

/** The highest shipping rate a provider may quote, in the base currency; a higher one is dropped. */
export const PROVIDER_MAX_RATE = 100_000;

const addressText = z.string().max(200);

/** What each surface's ops return, before the engine applies it. */
export const PROVIDE_RESULT_SCHEMAS = {
  'shipping.rates': {
    // Each option is checked as a live carrier's is (`parseCarrierQuote`); malformed ones drop.
    quote: z.object({ options: z.array(z.unknown()).max(50) }),
  },
  'shipping.labels': {
    // No label link: a URL anyone can fetch would carry the buyer's address to every plugin and
    // webhook that sees the node's output.
    create: z.object({
      labels: z
        .array(
          z.object({
            ref: shortText(120),
            /** The provider's own id for the label, sent back to `void`. */
            id: plainText(120),
            tracking: plainText(80),
            carrier: plainText(40).optional(),
          }),
        )
        .min(1)
        .max(50),
    }),
    void: z.object({ summary: z.string().transform(clip).optional() }),
  },
  tax: {
    calculate: z.object({ amount: z.number().nonnegative().finite() }),
  },
  address: {
    // `ShipAddress`'s keys only, so redaction (which goes by key) knows every field.
    validate: z
      .object({
        status: z.enum(['valid', 'corrected', 'invalid']),
        address: z
          .strictObject({
            name: addressText.optional(),
            line1: addressText.optional(),
            line2: addressText.optional(),
            city: addressText.optional(),
            region: addressText.optional(),
            postalCode: addressText.optional(),
            country: addressText.optional(),
          })
          .nullable(),
        issues: z.array(z.string().max(PLUGIN_SUMMARY_MAX)).max(5),
      })
      .refine((r) => r.status !== 'corrected' || r.address !== null, {
        message: 'A corrected address needs the address',
        path: ['address'],
      }),
  },
} as const;

type ResultOf<
  S extends ProviderSurface,
  O extends string,
> = S extends keyof typeof PROVIDE_RESULT_SCHEMAS
  ? O extends keyof (typeof PROVIDE_RESULT_SCHEMAS)[S]
    ? z.output<(typeof PROVIDE_RESULT_SCHEMAS)[S][O] & z.ZodType>
    : never
  : never;

export type ProvideResult<S extends ProviderSurface = ProviderSurface, O extends string = string> =
  | ResultOf<S, O>
  | { fail: { message: string; retry?: boolean } };

/** A checked provider result: what to apply, or how the call failed. */
export type ProvideOutcome<T> =
  | { kind: 'done'; value: T }
  | { kind: 'fail'; message: string; retry: boolean };

/**
 * Checks what a provider returned for `surface` and `op`. Throws, naming the problem, for a result
 * the engine must not apply (not the contract's shape, or over `PLUGIN_RESULT_MAX_BYTES`).
 */
export function checkProvideResult<S extends ProviderSurface, O extends ProvideOp>(
  plugin: string,
  surface: S,
  op: O,
  value: unknown,
): ProvideOutcome<ResultOf<S, O>> {
  const what = `${plugin} (${surface} ${op})`;
  const sized = jsonSized('The result').safeParse(value ?? null);
  if (!sized.success)
    throw new Error(`${what} returned an invalid result: ${sized.error.issues[0]?.message}`);
  const raw = value ?? {};
  if (raw && typeof raw === 'object' && 'fail' in raw) {
    const f = failSchema.safeParse(raw);
    if (!f.success) throw new Error(`${what} returned an invalid failure`);
    return { kind: 'fail', message: f.data.fail.message, retry: f.data.fail.retry === true };
  }
  const schema = (PROVIDE_RESULT_SCHEMAS[surface] as Record<string, z.ZodType>)[op];
  if (!schema) throw new Error(`${surface} has no ${op}`);
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(
      `${what} returned an invalid result: ${issue?.path.join('.') || 'result'}: ${issue?.message}`,
    );
  }
  return { kind: 'done', value: r.data as ResultOf<S, O> };
}

/** The plugins a node depends on: its own type's, and the one its Provider field names. */
export function nodePlugins(node: { type: string; config?: Record<string, unknown> }): string[] {
  const own = pluginOf(node.type);
  const provider = nodeProvider(nodeSpec(node.type), node.config)?.plugin;
  return [...new Set([own, provider].filter((x): x is string => !!x))];
}

/** The plugins a flow depends on, for its `load-plugins` step, usage and removal checks. */
export const flowPlugins = (graph: {
  nodes: { type: string; config?: Record<string, unknown> }[];
}) => new Set(graph.nodes.flatMap(nodePlugins));

/**
 * The RPC every plugin Worker's default entrypoint implements. `fetch` serves its pages: a request
 * under `/plugins/<id>/` arrives with the signed principal header (`verifyPrincipal`), except on the
 * manifest's `publicPaths`.
 */
export interface PluginRpc {
  manifest(): Promise<PluginManifest>;
  execute(req: PluginExecRequest): Promise<PluginExecResult>;
  /** Undoes `execute`. Idempotent: it may run more than once for the same step key. */
  compensate(req: PluginCompensateRequest): Promise<string>;
  /** An outbound event. Idempotent on `payload.id`, which is stable across redeliveries. */
  deliver(payload: OutboundPayload): Promise<void>;
  /** Does a built-in node's work for a surface in the manifest's `provides`. */
  provide(req: ProvideRequest): Promise<ProvideResult>;
  /**
   * With `carts:external`: the form fields that return an external cart this plugin opened to the
   * buyer's own system (a punchout order message, say). The core posts them to the cart's
   * `returnUrl`; checked by `checkCartReturn`.
   */
  renderReturn(req: CartReturnRequest): Promise<CartReturn>;
}

/**
 * One installed plugin as the engine sees it: a `PLUGIN_<ID>` binding (`worker`) or a bundle the
 * deployment pins (`sandboxed`). `manifest` is what the deployment runs: null when the plugin is
 * refused (its manifest doesn't parse, its id doesn't match, a plugin it requires is missing), and
 * the last good one while the plugin is unreachable. `healthy` is whether the plugin answered with
 * a usable manifest just now.
 */
export type PluginStatus = {
  id: string;
  runtime: PluginRuntime;
  /** Pinned by the deployment's registry (CI), or installed by an admin at runtime. */
  source: PluginSource;
  /** The running version's bundle, for a plugin installed at runtime: its page key is that version's. */
  sha?: string;
  manifest: PluginManifest | null;
  healthy: boolean;
  error?: string;
};

/** What still uses a plugin; it can be removed only once every list is empty. */
export type PluginUsage = {
  /** Flows whose published version uses the plugin's nodes, or names it as a Provider. */
  flows: { id: string; version: number }[];
  /** Orders still running on a flow version that does. */
  orders: { id: string; flowId: string; version: number }[];
  /** Labels it made that it couldn't void yet (`void_failed`), retried daily. */
  labels: { id: string; orderId: string }[];
};

// ── Node registry ────────────────────────────────────────────────────────────

/** Node lookups for a set of installed plugins: the built-in catalog plus each plugin's nodes. */
export type NodeRegistry = {
  spec(type: string): NodeSpec | undefined;
  outputs(type: string, config?: Record<string, unknown>): string[];
  withDefaults(type: string, config?: Record<string, unknown>): Record<string, unknown>;
  validate(type: string, config: Record<string, unknown>): string[];
  /** The installed plugins' node specs, for the palette. */
  pluginNodes(): { plugin: PluginManifest; spec: NodeSpec }[];
  /** Ids of the installed plugins. */
  installed(): string[];
  /** The installed plugins that provide `surface`, for a node's Provider field. */
  providers(surface: ProviderSurface): { id: string; name: string }[];
};

function toNodeSpec(n: PluginNodeSpec): NodeSpec {
  const fields: ConfigField[] = n.fields.map(({ jsonSchema, ...f }) => ({
    ...f,
    ...(jsonSchema
      ? {
          schema: z
            .unknown()
            .refine((v) => conforms(v, jsonSchema), "Doesn't match the expected shape"),
        }
      : {}),
  }));
  return {
    type: n.type,
    category: n.category as NodeCategory,
    label: n.label,
    description: n.description,
    icon: n.icon,
    fields,
    outputs: n.outputs,
    rollback: n.rollback,
    retries: n.retries,
  };
}

/** The registry for these installed plugins' manifests. */
export function withPlugins(manifests: readonly PluginManifest[]): NodeRegistry {
  const byType = new Map<string, { plugin: PluginManifest; spec: NodeSpec }>();
  for (const m of manifests)
    for (const n of m.nodes) {
      if (nodeSpec(n.type)) throw new Error(`Plugin ${m.id}: ${n.type} is a built-in node type`);
      byType.set(n.type, { plugin: m, spec: toNodeSpec(n) });
    }
  const spec = (type: string) => nodeSpec(type) ?? byType.get(type)?.spec;
  return {
    spec,
    outputs: (type, config = {}) =>
      nodeSpec(type) ? nodeOutputs(type, config) : ((spec(type)?.outputs as string[]) ?? []),
    withDefaults: (type, config) => specDefaults(spec(type), config),
    validate: (type, config) => {
      const s = spec(type);
      if (!s) return [missing(type)];
      const merged = specDefaults(s, config);
      const errors = validateFields(s, merged);
      const p = nodeProvider(s, merged);
      if (p) {
        const m = manifests.find((x) => x.id === p.plugin);
        if (!m) errors.push(`Provider: plugin “${p.plugin}” is not installed`);
        else if (!m.provides.includes(p.surface))
          errors.push(
            `Provider: plugin “${p.plugin}” doesn't provide ${PROVIDER_SURFACE_LABELS[p.surface].toLowerCase()}`,
          );
      }
      return errors;
    },
    pluginNodes: () => [...byType.values()],
    installed: () => manifests.map((m) => m.id),
    providers: (surface) =>
      manifests
        .filter((m) => m.provides.includes(surface))
        .map((m) => ({ id: m.id, name: m.name })),
  };
}

/** The built-in catalog alone: what a deployment with no plugins runs. */
export const staticRegistry: NodeRegistry = withPlugins([]);

/** The message for a node whose plugin isn't installed (or doesn't offer that type). */
export function missing(type: string): string {
  const plugin = pluginOf(type);
  return plugin ? `Plugin “${plugin}” is not installed` : `Unknown node type “${type}”`;
}

// ── Signed bundles (runtime installs) ───────────────────────────────────────

/** Where an installed plugin came from: the deployment's registry (CI), or an admin at runtime. */
export type PluginSource = 'deployment' | 'installed';

/** The largest `.olplugin` file an admin may upload. */
export const PLUGIN_BUNDLE_MAX_BYTES = 5 * 1024 * 1024;

/** A runtime install's lifecycle; at most one `active` or `disabled` row per plugin id. */
export const PLUGIN_INSTALL_STATUSES = [
  'pending',
  'active',
  'disabled',
  'superseded',
  'uninstalled',
] as const;
export type PluginInstallStatus = (typeof PLUGIN_INSTALL_STATUSES)[number];

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * A signed bundle, as `scripts/plugin-pack.ts` writes it (`.olplugin`): the sandbox bundle's body
 * exactly as CI would build it (`{ code, migrations, manifest }`), its SHA-256, and an Ed25519
 * signature over `bundleSigningMessage` by a publisher the deployment lists.
 */
export const pluginBundleFileSchema = z.object({
  format: z.literal(1),
  id: pluginId,
  version: z.string().min(1).max(64),
  sha: z.string().regex(/^[0-9a-f]{64}$/, 'A SHA-256, hex'),
  body: z.string().min(2),
  publisher: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'A publisher name'),
  signature: z.string().regex(B64URL, 'base64url').max(200),
});
export type PluginBundleFile = z.infer<typeof pluginBundleFileSchema>;

/** What a publisher signs: the format, the plugin, its version and the bundle's hash. */
export const bundleSigningMessage = (id: string, version: string, sha: string) =>
  `orderloop-plugin:1:${id}:${version}:${sha}`;

const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Whether `publicKey` (raw 32 bytes, base64url) signed this bundle file. */
export async function verifyBundleSignature(
  publicKey: string,
  file: Pick<PluginBundleFile, 'id' | 'version' | 'sha' | 'signature'>,
): Promise<boolean> {
  try {
    const raw = fromB64url(publicKey);
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromB64url(file.signature),
      new TextEncoder().encode(bundleSigningMessage(file.id, file.version, file.sha)),
    );
  } catch {
    return false;
  }
}

/** A publisher's key as the registry holds it: raw Ed25519, 32 bytes, base64url (43 characters). */
export const PUBLISHER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** What an admin reviews before approving: who signed it, what it is, and what it asks for. */
export type PluginInstallView = {
  id: string;
  sha: string;
  version: string;
  publisher: string;
  status: PluginInstallStatus;
  personalDataGranted: boolean;
  uploadedBy: string;
  uploadedAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  manifest: PluginManifest;
  /** Never a value: whether each declared secret is set. */
  secrets: { name: string; set: boolean }[];
  /** An assistant draft's: what the admin asked for. */
  request: string | null;
  /** An assistant draft's test cases, with their last results. */
  cases: PluginCaseResult[] | null;
  /** An assistant draft's rule code, to review (an uploaded file's code isn't shown). */
  code: string | null;
};

/** The publisher an assistant draft is staged under (never a key in the registry). */
export const ASSISTANT_PUBLISHER = 'assistant';

/**
 * A test case of an assistant-drafted rule: an order (a `RedactedOrder`, any field left out
 * taken from `sampleRedactedOrder`), the node's config, and the branch (and variables) it must give.
 */
export const pluginCaseSchema = z.object({
  name: z.string().min(1).max(120),
  node: z.string().regex(/^[a-z][a-z0-9_]*$/),
  order: z.record(z.string(), z.unknown()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  expect: z.object({
    branch: z.string().min(1),
    vars: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type PluginCase = z.infer<typeof pluginCaseSchema>;

/** At most this many cases a draft. */
export const PLUGIN_CASES_MAX = 30;

export const pluginCasesSchema = z.array(pluginCaseSchema).max(PLUGIN_CASES_MAX);

/** A case and what the rule gave: `pass`, or what it did instead. */
export type PluginCaseResult = PluginCase & {
  pass: boolean;
  /** The branch taken, or null when the rule failed. */
  got: { branch: string | null; vars?: Record<string, unknown>; error?: string };
};

/**
 * A plausible redacted order for a rule's test case: one line, USD, web channel, shipping to the
 * US, with `over` replacing any field. Totals follow the lines unless `over` sets them.
 */
export function sampleRedactedOrder(over: Record<string, unknown> = {}): RedactedOrder {
  const lines: RedactedOrder['lines'] = Array.isArray(over.lines)
    ? (over.lines as RedactedOrder['lines'])
    : [{ sku: 'SKU-1', name: 'Sample item', qty: 1, unitPrice: 100 }];
  const subtotal = lines.reduce((t, l) => t + l.qty * (l.unitPrice ?? 0), 0);
  return {
    id: 'ord_case',
    model: 'b2c',
    channel: 'web',
    customerId: undefined,
    lines,
    subtotal,
    shipping: 0,
    shippingOption: undefined,
    tax: 0,
    total: subtotal,
    baseTotal: subtotal,
    currency: 'USD',
    fulfillment: undefined,
    title: 'Test order',
    guest: false,
    shipToCountry: 'US',
    meta: {},
    createdAt: 0,
    ...over,
  } as unknown as RedactedOrder;
}
