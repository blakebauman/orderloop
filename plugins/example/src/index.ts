/**
 * The example plugin: one of each extension point, built with definePlugin, for the engine's and
 * web app's tests and as the template for a real plugin (docs/plugins.md).
 *
 * - `example.stamp` writes a row keyed by the order and its step key, so a retried step writes it
 *   once, and its compensation deletes that row.
 * - `example.probe` (test-only) does whatever its `behave` field says: echo what it was sent, fail,
 *   return too much, take a branch it doesn't have, or set variables. The engine's tests use it to
 *   check what the engine refuses.
 * - It subscribes to `order.completed` and records each delivery id once.
 * - `/plugins/example/` answers with the person the web app signed onto the request, and
 *   `/plugins/example/public/ping` is a public path that answers anyone.
 */

import { PLUGIN_RESULT_MAX_BYTES } from '@orderloop/core';
import { definePlugin } from '@orderloop/plugin-sdk';

export default definePlugin<Env>({
  manifest: {
    apiVersion: 1,
    id: 'example',
    name: 'Example',
    version: '2',
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
      {
        type: 'example.probe',
        category: 'control',
        label: 'Probe',
        description: 'Test-only: behaves as told, to check what the engine accepts from a plugin.',
        icon: 'FlaskConical',
        fields: [
          {
            key: 'behave',
            label: 'Behave',
            kind: 'select',
            options: ['echo', 'fail', 'fail_retry', 'big', 'bad_branch', 'vars'],
            default: 'echo',
          },
        ],
        outputs: ['out'],
      },
    ],
    events: ['order.completed'],
    nav: [{ label: 'Example', path: '/plugins/example/', icon: 'Puzzle' }],
    publicPaths: ['/plugins/example/public/ping'],
  },

  nodes: {
    stamp: {
      async execute({ req, env, key }) {
        if (req.config.skip === true) return { branch: 'skipped', summary: 'Skipped' };
        const note = typeof req.config.note === 'string' ? req.config.note : 'stamped';
        await env.DB.prepare(
          'INSERT INTO stamps (order_id, step_key, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        )
          .bind(req.orderId, req.stepKey, note, Date.now())
          .run();
        return { branch: 'ok', output: { key, note }, summary: `Stamped “${note}”` };
      },
      async compensate({ req, env }) {
        const r = await env.DB.prepare('DELETE FROM stamps WHERE order_id = ? AND step_key = ?')
          .bind(req.orderId, req.stepKey)
          .run();
        return r.meta.changes ? 'Removed the stamp' : 'No stamp to remove';
      },
    },
    probe: {
      execute({ req, fail }) {
        switch (req.config.behave) {
          case 'fail':
            return fail('Probe declined');
          case 'fail_retry':
            return fail('Probe busy', { retry: true });
          case 'big':
            return { output: 'x'.repeat(PLUGIN_RESULT_MAX_BYTES + 1) };
          case 'bad_branch':
            return { branch: 'elsewhere' };
          case 'vars':
            return { vars: { probed: true }, summary: 'Set vars' };
          default:
            return { output: { order: req.order, vars: req.vars }, summary: 'Echoed' };
        }
      },
    },
  },

  events: {
    async 'order.completed'(payload, env) {
      await env.DB.prepare(
        'INSERT INTO deliveries (id, event, order_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
        .bind(payload.id, payload.event, payload.orderId, Date.now())
        .run();
    },
  },

  pages(request, { principal }) {
    if (new URL(request.url).pathname === '/plugins/example/public/ping')
      return Response.json({ ok: true });
    return Response.json(
      { plugin: 'example', principal: principal && { id: principal.id, role: principal.role } },
      // Things the web app must not let through to the browser as they are.
      { headers: { 'set-cookie': 'session=stolen; Path=/', 'x-frame-options': 'ALLOWALL' } },
    );
  },
});
