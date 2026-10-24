/**
 * The assistant drafts a business-rule plugin for an admin: flow steps that decide a branch from
 * the order (`draft_plugin`). The model writes only the rule bodies and their test cases; the
 * engine writes everything else, so the guardrails are structural, not a matter of review:
 *
 * - the manifest: no outside hosts, secrets, buyer details, pages, events or storage, and the
 *   strictest limits;
 * - the module: a fixed host (`hostModule`) around the model's `rules`, with no SDK and no imports;
 * - the code: refused if it is too long or names what a rule never needs (`FORBIDDEN`), a backstop to
 *   the sandbox, which has no network, no storage, no secrets and a CPU cap per call.
 *
 * The draft is staged like an upload (`stageBundle`), under the publisher `assistant`, and runs only
 * once an admin has reviewed its code, seen its cases pass and approved it with a step-up. See
 * docs/plugins.md, "Assistant-drafted plugins".
 */

import {
  ASSISTANT_PUBLISHER,
  type AuditVia,
  boundText,
  PLUGIN_API_VERSION,
  PLUGIN_ID_RE,
  type PluginCase,
  type PluginDraftResult,
  type PluginManifest,
  type Principal,
  parseManifest,
  pluginCasesSchema,
} from '@orderloop/core';
import { createDb, installedPlugins } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { runJson } from '../ai';
import { recordAudit } from '../audit';
import { runCases } from '../plugin-cases';
import { assistantDrafts, InstallRefused, sha256, stageBundle } from '../plugin-installs';
import { Refused } from './data';

/** The longest rule code the assistant may write. */
export const DRAFT_CODE_MAX = 16 * 1024;

/**
 * What a rule never needs: modules, code from strings, the network, the runtime's internals and the
 * host's own names. A heuristic, not a boundary: the sandbox stops all of it anyway (no network, no
 * storage, no secrets, a CPU cap); this refuses a draft that tries, before an admin reviews it.
 */
const FORBIDDEN = [
  'import',
  'export',
  'require',
  'eval',
  'Function',
  'fetch',
  'globalThis',
  'WebAssembly',
  'caches',
  'XMLHttpRequest',
  'WebSocket',
  'WorkerEntrypoint',
  'MANIFEST_JSON',
  '__proto__',
  'constructor',
  'prototype',
  'defineProperty',
  'setPrototypeOf',
  'Reflect',
  'Proxy',
  'process',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`);

/**
 * The code without comments or the text of its string literals (a template's `${…}` code is kept),
 * so the check reads what runs, not what a summary says ("export orders…").
 */
export function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  let depth = 0;
  const templates: number[] = [];
  const template = (from: number) => {
    let j = from;
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') {
        out += '``';
        return j + 1;
      } else if (src[j] === '$' && src[j + 1] === '{') {
        out += '`${';
        templates.push(depth);
        return j + 2;
      } else j++;
    }
    return j;
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += '""';
    } else if (c === '`') i = template(i + 1);
    else if (c === '}' && templates.length && templates.at(-1) === depth) {
      templates.pop();
      out += '}';
      i = template(i + 1);
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      i++;
    }
  }
  return out;
}

const NODE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const OUTPUT_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** What the model answers: rule steps, their code and their test cases. */
export type DraftAnswer = {
  name: string;
  description: string;
  nodes: {
    name: string;
    label: string;
    description: string;
    outputs: string[];
    fields: {
      key: string;
      label: string;
      type: 'number' | 'string' | 'boolean';
      default: number | string | boolean;
    }[];
  }[];
  code: string;
  cases: PluginCase[];
};

const DRAFT_SCHEMA = {
  type: 'object',
  required: ['name', 'description', 'nodes', 'code', 'cases'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'label', 'description', 'outputs', 'fields'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          outputs: { type: 'array', items: { type: 'string' } },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'label', 'type', 'default'],
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', enum: ['number', 'string', 'boolean'] },
                default: {},
              },
            },
          },
        },
      },
    },
    code: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'node', 'order', 'expect'],
        properties: {
          name: { type: 'string' },
          node: { type: 'string' },
          order: { type: 'object' },
          config: { type: 'object' },
          expect: {
            type: 'object',
            required: ['branch'],
            properties: { branch: { type: 'string' }, vars: { type: 'object' } },
          },
        },
      },
    },
  },
};

const SYSTEM = [
  'You write business-rule steps for OrderLoop, an order-operations system. Each order runs a flow of steps; a rule step looks at the order and picks one of its outputs (a branch), e.g. "hold" or "ok".',
  'Answer only JSON with: name (a short plugin name), description, nodes (each: name in snake_case, label, description, outputs (the branches, the usual one last), fields (settings a person can change in the flow editor: key, label, type number|string|boolean, default)), code, and cases.',
  "code is plain JavaScript that defines exactly: const rules = { <node name>: ({ order, config, vars }) => ({ branch, summary, vars }) }. A rule may be async. It returns branch (one of the node's outputs), summary (one short line for the order's timeline) and optionally vars (values for later steps). No imports, no network, no globals, no Date.now: decide only from the order and config.",
  'order has: id, model (b2b|b2c|...), channel, customerId (absent for a guest), guest (boolean), lines [{ sku, name, qty, unitPrice, sellerId? }], subtotal, shipping, shippingOption, tax, total, baseTotal (in the base currency), currency, fulfillment { method }, shipToCountry (ISO code), title, externalId, createdAt (ms). It never has names, emails or addresses.',
  'cases: at least two per node, covering every branch: { name, node, order (only the fields that matter; the rest are filled with a plain one-line US order of 100 USD), config (optional; defaults are filled), expect: { branch, vars? } }.',
  'Put thresholds and lists in fields with sensible defaults rather than in the code.',
].join('\n');

/** `ai-<slug>`: a plugin id from the name the model gave. */
export function draftId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  const id = `ai-${slug || 'rules'}`;
  return PLUGIN_ID_RE.test(id) ? id : 'ai-rules';
}

/** Refuses a draft whose shape or code a rule plugin can't have; returns what was wrong, or null. */
export function draftProblem(a: DraftAnswer): string | null {
  if (!a.nodes.length) return 'it has no steps';
  if (a.nodes.length > 10) return 'it has more than 10 steps';
  const names = new Set<string>();
  for (const n of a.nodes) {
    if (!NODE_NAME_RE.test(n.name)) return `the step name “${n.name}” isn't snake_case`;
    if (names.has(n.name)) return `two steps are named “${n.name}”`;
    names.add(n.name);
    if (!n.outputs.length || n.outputs.length > 8) return `${n.name} needs 1 to 8 outputs`;
    if (n.outputs.some((o) => !OUTPUT_RE.test(o)))
      return `${n.name} has an output that isn't a short name`;
    if (new Set(n.outputs).size !== n.outputs.length) return `${n.name} repeats an output`;
    for (const f of n.fields) if (!KEY_RE.test(f.key)) return `the setting “${f.key}” isn't a key`;
  }
  if (new TextEncoder().encode(a.code).byteLength > DRAFT_CODE_MAX)
    return `its code is over ${DRAFT_CODE_MAX / 1024} KiB`;
  const code = codeOnly(a.code);
  const bad = FORBIDDEN_RE.exec(code)?.[1];
  if (bad) return `its code uses “${bad}”, which a rule may not`;
  // An escaped name (\u0066etch) outside a string would get past the list.
  if (/\\[ux]/.test(code)) return 'its code uses an escape outside a string';
  if (!/\bconst\s+rules\s*=/.test(a.code)) return 'its code doesn’t define `const rules = { … }`';
  return null;
}

/** The manifest, written by the engine: whatever the model said, it reaches nothing. */
export function draftManifest(id: string, version: string, a: DraftAnswer): PluginManifest {
  return parseManifest({
    apiVersion: PLUGIN_API_VERSION,
    id,
    name: a.name.slice(0, 80) || id,
    version,
    nodes: a.nodes.map((n) => ({
      type: `${id}.${n.name}`,
      category: 'commerce',
      label: n.label.slice(0, 80) || n.name,
      description: n.description.slice(0, 300),
      icon: 'scale',
      outputs: n.outputs,
      fields: n.fields.map((f) => ({
        key: f.key,
        label: f.label.slice(0, 80) || f.key,
        kind: f.type === 'string' ? 'text' : f.type,
        default: f.default,
      })),
      retries: 0,
    })),
    events: [],
    nav: [],
    publicPaths: [],
    requires: [],
    personalData: 'redact',
    secrets: [],
    provides: [],
    egress: [],
    limits: { cpuMs: 50, subRequests: 0 },
  });
}

/**
 * The module the sandbox loads: the model's `rules`, scoped in a function, behind a fixed host that
 * answers the manifest (from a string, so a rule can't change it), runs one rule per node and turns
 * a throw into a failed step. Nothing to undo: rules write nothing.
 */
export function hostModule(manifest: PluginManifest, rules: string): string {
  return `import { WorkerEntrypoint } from 'cloudflare:workers';
const MANIFEST_JSON = ${JSON.stringify(JSON.stringify(manifest))};
const ID = ${JSON.stringify(manifest.id)};
const rules = (() => {
  'use strict';
${rules}
;
  return typeof rules === 'object' && rules !== null ? rules : {};
})();
export default class extends WorkerEntrypoint {
  async manifest() {
    return JSON.parse(MANIFEST_JSON);
  }
  async execute(req) {
    const name = String(req.type).slice(ID.length + 1);
    const rule = Object.prototype.hasOwnProperty.call(rules, name) ? rules[name] : undefined;
    if (typeof rule !== 'function') return { fail: { message: 'No rule for ' + name } };
    try {
      return await rule({ order: req.order, config: req.config, vars: req.vars });
    } catch (err) {
      return { fail: { message: String((err && err.message) || err).slice(0, 300) } };
    }
  }
  async compensate() {
    return 'Nothing to undo';
  }
  // Rules serve no pages, take no events and provide nothing: own methods, so nothing a rule adds
  // to a prototype answers in their place.
  async fetch() {
    return new Response('Not found', { status: 404 });
  }
  async deliver() {
    throw new Error('Rules take no events');
  }
  async provide() {
    throw new Error('Rules provide nothing');
  }
}
`;
}

/**
 * In mock mode, without the model: one threshold rule from "over <amount>", so the feature works
 * offline and in tests. Never a stand-in for a failed model call: that is refused.
 */
export function heuristicDraft(instruction: string): DraftAnswer {
  const m = /\b(?:over|above|more than|exceeds?|>)\s*\$?\s*([\d,.]+)\s*(k)?/i.exec(instruction);
  const limit = m ? Number(m[1]!.replace(/,/g, '')) * (m[2] ? 1000 : 1) : 1000;
  return {
    name: 'Order threshold',
    description: `Holds orders whose total is over a limit (${limit} by default).`,
    nodes: [
      {
        name: 'over_limit',
        label: 'Over the limit?',
        description: 'Holds an order whose total is over the limit.',
        outputs: ['hold', 'ok'],
        fields: [{ key: 'limit', label: 'Limit', type: 'number', default: limit }],
      },
    ],
    code: [
      'const rules = {',
      '  over_limit: ({ order, config }) =>',
      '    order.total > config.limit',
      "      ? { branch: 'hold', summary: 'Total ' + order.total + ' is over ' + config.limit }",
      "      : { branch: 'ok', summary: 'Within the limit' },",
      '};',
    ].join('\n'),
    cases: [
      {
        name: 'Over the limit',
        node: 'over_limit',
        order: { total: limit + 1 },
        config: {},
        expect: { branch: 'hold' },
      },
      {
        name: 'At the limit',
        node: 'over_limit',
        order: { total: limit },
        config: {},
        expect: { branch: 'ok' },
      },
    ],
  };
}

/**
 * Drafts (or revises, as its next version) a rule plugin for `instruction` and stages it for review.
 * Refused while the deployment doesn't allow assistant drafts, and for a draft a rule can't be.
 */
export async function draftPlugin(
  env: Env,
  p: Principal,
  instruction: string,
  opts: { pluginId?: string; via: AuditVia },
): Promise<PluginDraftResult> {
  if (!assistantDrafts(env))
    throw new Refused(
      'This workspace doesn’t let the assistant draft plugins. Ask OrderLoop to turn it on.',
    );
  const ask = instruction.trim().slice(0, 2000);
  try {
    return await draft(env, p, ask, opts);
  } catch (err) {
    // A refused draft (bad code above all) is worth a look: the request may have been steered.
    if (err instanceof Refused)
      await recordAudit(env, 'plugin.draft_refused', {
        actor: p,
        target: opts.pluginId ?? null,
        detail: { via: opts.via, reason: err.message, request: boundText(ask, 200) },
      });
    throw err;
  }
}

async function draft(
  env: Env,
  p: Principal,
  ask: string,
  opts: { pluginId?: string; via: AuditVia },
): Promise<PluginDraftResult> {
  if (!ask) throw new Refused('Say what the rule should do.');
  const rowsOf = (id: string) =>
    createDb(env.DB)
      .select({
        sha: installedPlugins.sha,
        version: installedPlugins.version,
        publisher: installedPlugins.publisher,
        status: installedPlugins.status,
      })
      .from(installedPlugins)
      .where(eq(installedPlugins.id, id));
  if (opts.pluginId) {
    const own = (await rowsOf(opts.pluginId)).filter((r) => r.status !== 'uninstalled');
    if (
      !/^ai-/.test(opts.pluginId) ||
      !own.length ||
      own.some((r) => r.publisher !== ASSISTANT_PUBLISHER)
    )
      throw new Refused(`${opts.pluginId} wasn’t drafted by the assistant, so it can’t revise it`);
  }
  const answer = await runJson<DraftAnswer>(
    env,
    'plugin_draft',
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: ask },
    ],
    DRAFT_SCHEMA,
    () => heuristicDraft(ask),
    { model: String(env.ASSISTANT_MODEL), maxTokens: 4096 },
  );
  // Only mock mode drafts without the model: a failed call must not pass off a stock rule.
  if (answer.source === 'heuristic' && answer.fallback !== 'mock')
    throw new Refused(`The model couldn’t draft that (${answer.fallback}). Try again.`);
  const a = answer.value;
  const problem = draftProblem(a);
  if (problem) throw new Refused(`The draft can’t be used: ${problem}. Try asking again.`);
  const cases = pluginCasesSchema.safeParse(a.cases);
  if (!cases.success) throw new Refused('The draft’s test cases don’t read. Try asking again.');

  // A new request gets an id of its own; only naming a drafted plugin revises it.
  let id = opts.pluginId ?? draftId(a.name);
  let rows = await rowsOf(id);
  if (!opts.pluginId)
    for (let n = 2; rows.length; n++) {
      id = `${draftId(a.name)}-${n}`;
      rows = await rowsOf(id);
    }
  const version = String(Math.max(0, ...rows.map((r) => Number(r.version) || 0)) + 1);
  let manifest: PluginManifest;
  try {
    manifest = draftManifest(id, version, a);
  } catch (err) {
    throw new Refused(
      `The draft can’t be used: ${err instanceof Error ? boundText(err.message, 200) : 'its steps don’t read'}. Try asking again.`,
    );
  }
  const code = hostModule(manifest, a.code);
  const body = JSON.stringify({ code, migrations: [], manifest, rules: a.code });
  const sha = await sha256(body);
  const results = await runCases(env, code, manifest, cases.data);
  try {
    await stageBundle(
      env,
      { sha, body, bundle: { code, migrations: [] }, manifest },
      ASSISTANT_PUBLISHER,
      p.id,
      { request: ask, cases: results },
    );
  } catch (err) {
    if (err instanceof InstallRefused) throw new Refused(err.message);
    throw err;
  }
  const passed = results.filter((r) => r.pass).length;
  await recordAudit(env, 'plugin.drafted', {
    actor: p,
    target: id,
    detail: {
      version,
      sha: sha.slice(0, 12),
      via: opts.via,
      cases: `${passed}/${results.length}`,
      request: boundText(ask, 200),
    },
  });
  return {
    id,
    sha,
    name: manifest.name,
    version,
    explanation: a.description.slice(0, 500),
    nodes: manifest.nodes.map((n) => ({ type: n.type, label: n.label })),
    cases: { total: results.length, passed },
    href: `/plugins#${id}`,
  };
}
