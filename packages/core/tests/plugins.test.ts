import { describe, expect, it } from 'vitest';
import {
  bundleSigningMessage,
  checkExecResult,
  checkProvideResult,
  egressAllows,
  type FlowGraph,
  flowPlugins,
  type Order,
  PLUGIN_RESULT_MAX_BYTES,
  PUBLISHER_KEY_RE,
  parseManifest,
  pluginBinding,
  pluginBundleFileSchema,
  pluginKey,
  pluginOf,
  pluginOrder,
  pluginSecretVar,
  pluginView,
  signPrincipal,
  staticRegistry,
  TEMPLATES,
  validateGraph,
  verifyBundleSignature,
  verifyPrincipal,
  withPlugins,
} from '../src';

const manifest = (over: Record<string, unknown> = {}) => ({
  apiVersion: 1,
  id: 'example',
  name: 'Example',
  version: '1',
  nodes: [
    {
      type: 'example.stamp',
      category: 'commerce',
      label: 'Stamp',
      description: 'Writes a stamp.',
      icon: 'Stamp',
      fields: [
        { key: 'note', label: 'Note', kind: 'text', default: 'hi' },
        { key: 'count', label: 'Count', kind: 'number' },
        {
          key: 'shape',
          label: 'Shape',
          kind: 'json',
          jsonSchema: { type: 'object', required: ['a'] },
        },
      ],
      outputs: ['ok', 'skipped'],
      rollback: true,
    },
  ],
  events: ['order.completed'],
  nav: [{ label: 'Example', path: '/plugins/example/', icon: 'Puzzle' }],
  ...over,
});

const flow = (type: string, handle = 'ok'): FlowGraph => ({
  nodes: [
    { id: 't', type: 'trigger.manual', label: 'Start', config: {}, position: { x: 0, y: 0 } },
    { id: 'p', type, label: 'Stamp', config: {}, position: { x: 0, y: 0 } },
    { id: 'e', type: 'control.end', label: 'End', config: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: 'a', source: 't', target: 'p' },
    { id: 'b', source: 'p', target: 'e', sourceHandle: handle },
  ],
});

describe('plugin manifests', () => {
  it('parses a valid manifest and fills defaults', () => {
    const m = parseManifest({ apiVersion: 1, id: 'example', name: 'Example', version: '1' });
    expect(m).toMatchObject({
      nodes: [],
      events: [],
      nav: [],
      publicPaths: [],
      requires: [],
      pageRole: 'operator',
      personalData: 'redact',
      secrets: [],
      provides: [],
      egress: [],
      limits: {},
    });
    expect(parseManifest(manifest()).nodes[0]!.type).toBe('example.stamp');
  });

  it('refuses a manifest written for another contract version', () => {
    expect(() => parseManifest(manifest({ apiVersion: 2 }))).toThrow(/apiVersion must be 1/);
    expect(() => parseManifest({ ...manifest(), apiVersion: undefined })).toThrow(/apiVersion/);
  });

  it('rejects bad and reserved ids', () => {
    expect(() => parseManifest(manifest({ id: 'Bad_ID' }))).toThrow(/id/);
    expect(() => parseManifest(manifest({ id: 'commerce' }))).toThrow(/reserved/);
  });

  it('requires node types in the plugin namespace', () => {
    const nodes = [{ ...manifest().nodes[0]!, type: 'other.stamp' }];
    expect(() => parseManifest(manifest({ nodes }))).toThrow(/example\.<name>/);
  });

  it('keeps nav and public paths under the plugin prefix', () => {
    expect(() => parseManifest(manifest({ publicPaths: ['/api/v1/x'] }))).toThrow(
      /\/plugins\/example\//,
    );
  });

  it('declares secrets by env name, none reserved or repeated', () => {
    const secrets = [
      { name: 'API_KEY', description: 'The carrier key' },
      { name: 'HOOK', optional: true },
    ];
    expect(parseManifest(manifest({ secrets })).secrets).toEqual(secrets);
    expect(() => parseManifest(manifest({ secrets: [{ name: 'api-key' }] }))).toThrow(/upper-case/);
    expect(() => parseManifest(manifest({ secrets: [{ name: 'PLUGIN_KEY' }] }))).toThrow(
      /reserved/,
    );
    expect(() => parseManifest(manifest({ secrets: [{ name: 'A' }, { name: 'A' }] }))).toThrow(
      /Duplicate secret/,
    );
  });

  it('refuses a node type the built-in catalog has', () => {
    // A plugin can't be named after a built-in category, so a collision needs a forged manifest.
    const forged = { ...parseManifest(manifest()), id: 'commerce' };
    forged.nodes = [{ ...forged.nodes[0]!, type: 'commerce.ship' }];
    expect(() => withPlugins([forged])).toThrow(/built-in/);
  });

  it('names bindings and namespaces', () => {
    expect(pluginBinding('qbd-sync')).toBe('PLUGIN_QBD_SYNC');
    expect(pluginSecretVar('qbd-sync', 'API_KEY')).toBe('PLUGIN_QBD_SYNC_API_KEY');
    expect(pluginOf('example.stamp')).toBe('example');
    expect(pluginOf('commerce.ship')).toBeNull();
    expect(pluginOf('nodot')).toBeNull();
  });
});

describe('node registry', () => {
  const registry = withPlugins([parseManifest(manifest())]);

  it('knows built-in and plugin nodes', () => {
    expect(registry.spec('commerce.ship')?.label).toBeTruthy();
    expect(registry.spec('example.stamp')?.rollback).toBe(true);
    expect(registry.outputs('example.stamp')).toEqual(['ok', 'skipped']);
    expect(registry.withDefaults('example.stamp', { count: 2 })).toEqual({ note: 'hi', count: 2 });
    expect(registry.installed()).toEqual(['example']);
    expect(registry.pluginNodes().map((n) => n.spec.type)).toEqual(['example.stamp']);
  });

  it("validates a plugin node's fields", () => {
    expect(registry.validate('example.stamp', {})).toEqual([]);
    expect(registry.validate('example.stamp', { count: 'two' })[0]).toMatch(/Count/);
    expect(registry.validate('example.stamp', { shape: { b: 1 } })[0]).toMatch(/Shape/);
    expect(registry.validate('example.stamp', { shape: { a: 1 } })).toEqual([]);
  });

  it('accepts a flow with a plugin node only when the plugin is installed', () => {
    expect(validateGraph(flow('example.stamp'), registry).errors).toEqual([]);
    expect(validateGraph(flow('example.stamp')).errors[0]!.message).toBe(
      'Plugin “example” is not installed',
    );
    expect(validateGraph(flow('example.stamp', 'nope'), registry).errors[0]!.message).toContain(
      'no “nope” output',
    );
  });

  it('leaves built-in flows as they were', () => {
    for (const make of Object.values(TEMPLATES)) {
      const t = make();
      expect(validateGraph(t, registry)).toEqual(validateGraph(t, staticRegistry));
    }
  });
});

describe('plugin results', () => {
  const outs = ['ok', 'skipped'];

  it('takes the first output by default and keeps what the node returned', () => {
    expect(checkExecResult('example.stamp', { output: { a: 1 }, summary: 'Done' }, outs)).toEqual({
      kind: 'done',
      branch: 'ok',
      output: { a: 1 },
      summary: 'Done',
      vars: undefined,
    });
    expect(checkExecResult('example.stamp', undefined, outs)).toMatchObject({ branch: 'ok' });
  });

  it('turns fail into a failure, retried only when the plugin says so', () => {
    expect(checkExecResult('x.y', { fail: { message: 'Declined' } }, outs)).toEqual({
      kind: 'fail',
      message: 'Declined',
      retry: false,
    });
    expect(checkExecResult('x.y', { fail: { message: 'Busy', retry: true } }, outs)).toMatchObject({
      retry: true,
    });
  });

  it('refuses a branch the node lacks, a long summary and an oversized output', () => {
    expect(() => checkExecResult('x.y', { branch: 'nope' }, outs)).toThrow(
      /isn't one of its outputs/,
    );
    // Long text is cut, not refused: refusing would turn a retryable failure into a final one.
    const long = checkExecResult('x.y', { summary: 's'.repeat(301) }, outs);
    expect(long.kind === 'done' && long.summary).toBe(`${'s'.repeat(299)}…`);
    expect(
      checkExecResult('x.y', { fail: { message: 'e'.repeat(5000), retry: true } }, outs),
    ).toMatchObject({
      kind: 'fail',
      retry: true,
      message: `${'e'.repeat(299)}…`,
    });
    const big = 'x'.repeat(PLUGIN_RESULT_MAX_BYTES);
    expect(() => checkExecResult('x.y', { output: big }, outs)).toThrow(/output is \d+ bytes/);
    expect(() => checkExecResult('x.y', { vars: { big } }, outs)).toThrow(/vars is \d+ bytes/);
    expect(() => checkExecResult('x.y', { vars: 'not an object' }, outs)).toThrow(/vars/);
  });
});

describe('what a plugin sees', () => {
  const order = {
    id: 'ord_1',
    model: 'b2c',
    channel: 'web',
    currency: 'USD',
    lines: [{ sku: 'WID-100', name: 'Widget', qty: 1, unitPrice: 5 }],
    contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
    meta: { shipTo: { line1: '1 Main St', city: 'Springfield' }, note: 'call 555 123 4567' },
    createdAt: 0,
    subtotal: 5,
    shipping: 0,
    tax: 0,
    total: 5,
  } as unknown as Order;

  it('gets no buyer details unless its manifest asks for them', () => {
    const seen = pluginOrder({ personalData: 'redact' }, {
      ...order,
      title: 'PO from ada@example.com',
      documentText: 'Ship to Ada Lovelace, 1 Main St, Springfield',
      documentKey: 'intake/abc.eml',
      payment: { provider: 'stripe', intentId: 'pi_123', paymentMethodId: 'pm_456' },
      meta: { buyerName: 'Ada Lovelace', note: 'call 555 123 4567' },
    } as Order);
    for (const k of ['contact', 'meta', 'documentText', 'documentKey', 'payment'])
      expect(seen).not.toHaveProperty(k);
    expect(seen.title).toBe('PO from [email]');
    expect(JSON.stringify(seen)).not.toMatch(/ada|lovelace|main st|555 123|pi_123|pm_456/i);
    expect(seen.lines[0]).toMatchObject({ sku: 'WID-100', name: 'Widget' });
    expect(pluginOrder({ personalData: 'send' }, order)).toBe(order);
    expect(pluginView({ personalData: 'redact' }, { buyer: { email: 'a@b.co' }, n: 1 })).toEqual({
      n: 1,
    });
  });
});

describe('plugin keys', () => {
  it("derive a plugin's own key that the principal key's holder can't be confused with", async () => {
    // The same vector as scripts/fleet.test.ts.
    expect(await pluginKey('test-principal-key', 'example')).toBe(
      '3b9f2f08046e6b872940790364b2e8be0fb31ec677270a2464f10a29e9fcae13',
    );
    const p = { kind: 'user' as const, id: 'usr_1', name: 'Ada', role: 'admin' as const };
    const forPlugin = await signPrincipal(await pluginKey('k', 'example'), p, '/plugins/example/');
    // The engine checks with the principal key; another plugin with its own key.
    expect(await verifyPrincipal(['k'], forPlugin, '/plugins/example/')).toBeNull();
    expect(
      await verifyPrincipal([await pluginKey('k', 'other')], forPlugin, '/plugins/example/'),
    ).toBeNull();
    expect(
      await verifyPrincipal([await pluginKey('k', 'example')], forPlugin, '/plugins/example/'),
    ).toMatchObject({ id: 'usr_1' });
  });
});

describe('providers', () => {
  const carrier = (over: Record<string, unknown> = {}) =>
    parseManifest(
      manifest({
        id: 'carrier',
        nodes: [],
        nav: [],
        publicPaths: [],
        personalData: 'send',
        provides: ['shipping.labels', 'shipping.rates'],
        ...over,
      }),
    );

  it('needs buyer details for surfaces that use the address, not for rates', () => {
    expect(() => carrier({ personalData: 'redact' })).toThrow(/needs the buyer's address/);
    expect(carrier({ personalData: 'redact', provides: ['shipping.rates'] }).provides).toEqual([
      'shipping.rates',
    ]);
    expect(() => carrier({ provides: ['tax', 'tax'] })).toThrow(/Duplicate surface/);
  });

  it('checks a node’s provider is installed and provides that surface', () => {
    const reg = withPlugins([carrier()]);
    expect(reg.providers('shipping.labels')).toEqual([{ id: 'carrier', name: 'Example' }]);
    expect(reg.providers('tax')).toEqual([]);
    expect(reg.validate('commerce.ship', { provider: 'carrier' })).toEqual([]);
    expect(reg.validate('commerce.ship', {})).toEqual([]);
    expect(reg.validate('commerce.tax', { provider: 'carrier' })).toEqual([
      "Provider: plugin “carrier” doesn't provide tax",
    ]);
    expect(staticRegistry.validate('commerce.ship', { provider: 'carrier' })).toEqual([
      'Provider: plugin “carrier” is not installed',
    ]);
  });

  it('counts a provider among the plugins a flow depends on', () => {
    expect([
      ...flowPlugins({
        nodes: [
          { type: 'commerce.ship', config: { provider: 'carrier' } },
          { type: 'commerce.tax', config: { provider: 'builtin' } },
          { type: 'example.stamp', config: {} },
        ],
      }),
    ]).toEqual(['carrier', 'example']);
  });

  it('checks provider results per surface and op', () => {
    const ok = checkProvideResult('carrier', 'shipping.labels', 'create', {
      labels: [{ ref: 'p1', id: 'L1', tracking: '1Z' }],
    });
    expect(ok).toEqual({
      kind: 'done',
      value: { labels: [{ ref: 'p1', id: 'L1', tracking: '1Z' }] },
    });
    expect(
      checkProvideResult('carrier', 'tax', 'calculate', { fail: { message: 'down', retry: true } }),
    ).toEqual({ kind: 'fail', message: 'down', retry: true });
    expect(() => checkProvideResult('carrier', 'tax', 'calculate', { amount: -1 })).toThrow(
      /carrier \(tax calculate\) returned an invalid result: amount/,
    );
    expect(() =>
      checkProvideResult('carrier', 'shipping.labels', 'create', {
        labels: [{ ref: 'p1', id: 'L1', tracking: '1Z\u202eevil' }],
      }),
    ).toThrow(/tracking/);
    expect(() =>
      checkProvideResult('carrier', 'address', 'validate', {
        status: 'corrected',
        address: null,
        issues: [],
      }),
    ).toThrow(/A corrected address needs the address/);
    expect(() =>
      checkProvideResult('carrier', 'address', 'validate', {
        status: 'valid',
        address: { street1: '1 Main' },
        issues: [],
      }),
    ).toThrow(/address/);
    expect(() =>
      checkProvideResult('carrier', 'shipping.rates', 'quote', {
        options: ['x'.repeat(PLUGIN_RESULT_MAX_BYTES)],
      }),
    ).toThrow(/limit/);
  });
});

describe('sandboxed plugins', () => {
  const sandboxed = (over: Record<string, unknown> = {}) =>
    parseManifest(
      manifest({
        id: 'carrier',
        nodes: [],
        nav: [],
        publicPaths: [],
        egress: ['api.carrier.test'],
        ...over,
      }),
    );

  it('declares egress hosts, limits, and secrets injected into one of them', () => {
    const m = sandboxed({
      egress: ['api.carrier.test', '*.labels.test'],
      limits: { cpuMs: 100 },
      secrets: [
        {
          name: 'API_KEY',
          inject: { host: 'api.carrier.test', header: 'Authorization', format: 'Bearer {}' },
        },
        { name: 'HOOK', expose: true },
      ],
    });
    expect(m.limits).toEqual({ cpuMs: 100 });
    expect(egressAllows(m.egress, 'api.carrier.test')).toBe(true);
    expect(egressAllows(m.egress, 'eu.labels.test')).toBe(true);
    expect(egressAllows(m.egress, 'labels.test')).toBe(true);
    expect(egressAllows(m.egress, 'api.carrier.test.evil')).toBe(false);
    expect(egressAllows(m.egress, 'xlabels.test')).toBe(false);
  });

  it('refuses injection outside egress, both modes at once, bad headers and limits over the caps', () => {
    const inject = (host: string, header = 'Authorization', format = 'Bearer {}') => ({
      secrets: [{ name: 'K', inject: { host, header, format } }],
    });
    expect(() => sandboxed(inject('other.test'))).toThrow(/Inject only into a host in egress/);
    expect(() => sandboxed(inject('api.carrier.test', 'Cookie'))).toThrow(/not allowed/);
    expect(() => sandboxed(inject('api.carrier.test', 'Authorization', 'Bearer'))).toThrow(/\{\}/);
    expect(() =>
      sandboxed({
        secrets: [
          {
            name: 'K',
            expose: true,
            inject: { host: 'api.carrier.test', header: 'X', format: '{}' },
          },
        ],
      }),
    ).toThrow(/either injected or exposed/);
    expect(() => sandboxed({ limits: { cpuMs: 5000 } })).toThrow(/limits/);
    expect(() => sandboxed({ egress: ['http://x.test'] })).toThrow(/egress/);
  });

  it('reserves ids that would collide with the engine’s plugin variables', () => {
    for (const id of ['bundles', 'secrets', 'grants', 'key'])
      expect(() => parseManifest(manifest({ id }))).toThrow(/reserved/);
  });
});

describe('signed bundles', () => {
  const b64url = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  type Pair = {
    privateKey: Parameters<typeof crypto.subtle.sign>[1];
    publicKey: Parameters<typeof crypto.subtle.exportKey>[1];
  };
  const keys = async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as Pair;
    return { pair, publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  };
  const sign = async (pair: Pair, id: string, version: string, sha: string) =>
    b64url(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        pair.privateKey,
        new TextEncoder().encode(bundleSigningMessage(id, version, sha)),
      ),
    );
  const sha = 'a'.repeat(64);

  it('verifies a publisher’s signature over the plugin, version and hash', async () => {
    const { pair, publicKey } = await keys();
    expect(publicKey).toMatch(PUBLISHER_KEY_RE);
    const file = {
      id: 'carrier',
      version: '1.0.0',
      sha,
      signature: await sign(pair, 'carrier', '1.0.0', sha),
    };
    expect(await verifyBundleSignature(publicKey, file)).toBe(true);
    // Anything signed for another version, plugin or hash, or by another key, fails.
    expect(await verifyBundleSignature(publicKey, { ...file, version: '1.0.1' })).toBe(false);
    expect(await verifyBundleSignature(publicKey, { ...file, id: 'other' })).toBe(false);
    expect(await verifyBundleSignature(publicKey, { ...file, sha: 'b'.repeat(64) })).toBe(false);
    expect(await verifyBundleSignature((await keys()).publicKey, file)).toBe(false);
    expect(await verifyBundleSignature('short', file)).toBe(false);
  });

  it('parses a bundle file and refuses a malformed one', () => {
    const file = {
      format: 1,
      id: 'carrier',
      version: '1.0.0',
      sha,
      body: '{}',
      publisher: 'acme',
      signature: 'abc_-',
    };
    expect(pluginBundleFileSchema.parse(file)).toEqual(file);
    expect(pluginBundleFileSchema.safeParse({ ...file, format: 2 }).success).toBe(false);
    expect(pluginBundleFileSchema.safeParse({ ...file, sha: 'xyz' }).success).toBe(false);
    expect(pluginBundleFileSchema.safeParse({ ...file, id: 'Bad' }).success).toBe(false);
  });
});
