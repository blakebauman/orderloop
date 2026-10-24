/**
 * The example plugin: one of each extension point, for the engine's and web app's tests (and as a
 * template for a real plugin; see docs/plugins.md).
 *
 * - `example.stamp` writes a row keyed by the order and its step key, so a retried step writes it
 *   once, and its compensation deletes that row.
 * - It subscribes to `order.completed` and records each delivery id once.
 * - `/plugins/example/` answers with the person the web app signed onto the request, and
 *   `/plugins/example/public/ping` is a public path that answers anyone.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  type OutboundPayload,
  type PluginCompensateRequest,
  type PluginExecRequest,
  type PluginExecResult,
  type PluginManifest,
  type PluginRpc,
  PRINCIPAL_HEADER,
  verifyPrincipal,
} from '@orderloop/core';

const MANIFEST: PluginManifest = {
  id: 'example',
  name: 'Example',
  version: '1',
  nodes: [
    {
      type: 'example.stamp',
      category: 'commerce',
      label: 'Stamp',
      description: 'Records a stamp for the order in the example plugin.',
      icon: 'Stamp',
      fields: [
        { key: 'note', label: 'Note', kind: 'text', default: 'stamped' },
        {
          key: 'skip',
          label: 'Skip',
          kind: 'boolean',
          default: false,
          hint: 'Take the “skipped” branch without stamping.',
        },
      ],
      outputs: ['ok', 'skipped'],
      rollback: true,
    },
  ],
  events: ['order.completed'],
  nav: [{ label: 'Example', path: '/plugins/example/', icon: 'Puzzle' }],
  publicPaths: ['/plugins/example/public/ping'],
  requires: [],
};

export default class ExamplePlugin extends WorkerEntrypoint<Env> implements PluginRpc {
  async manifest() {
    return MANIFEST;
  }

  async execute(req: PluginExecRequest): Promise<PluginExecResult> {
    if (req.config.skip === true) return { branch: 'skipped', summary: 'Skipped' };
    const note = typeof req.config.note === 'string' ? req.config.note : 'stamped';
    await this.env.DB.prepare(
      'INSERT INTO stamps (order_id, step_key, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
      .bind(req.orderId, req.stepKey, note, Date.now())
      .run();
    return { branch: 'ok', output: { stepKey: req.stepKey, note }, summary: `Stamped “${note}”` };
  }

  async compensate(req: PluginCompensateRequest) {
    const r = await this.env.DB.prepare('DELETE FROM stamps WHERE order_id = ? AND step_key = ?')
      .bind(req.orderId, req.stepKey)
      .run();
    return r.meta.changes ? 'Removed the stamp' : 'No stamp to remove';
  }

  async deliver(payload: OutboundPayload) {
    await this.env.DB.prepare(
      'INSERT INTO deliveries (id, event, order_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
      .bind(payload.id, payload.event, payload.orderId, Date.now())
      .run();
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/plugins/example/public/ping') return Response.json({ ok: true });
    const who = await verifyPrincipal(
      [this.env.PRINCIPAL_KEY, this.env.PRINCIPAL_KEY_PREVIOUS],
      request.headers.get(PRINCIPAL_HEADER),
      url.pathname,
    );
    if (!who) return new Response('Unauthorized', { status: 401 });
    return Response.json({ plugin: 'example', principal: { id: who.id, role: who.role } });
  }
}
