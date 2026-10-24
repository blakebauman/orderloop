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
import { definePlugin, pluginDb, secret } from '@orderloop/plugin-sdk';
import manifest from './manifest';

export default definePlugin<Env>({
  manifest,

  nodes: {
    stamp: {
      async execute({ req, env, key }) {
        if (req.config.skip === true) return { branch: 'skipped', summary: 'Skipped' };
        const note = typeof req.config.note === 'string' ? req.config.note : 'stamped';
        await pluginDb(env)
          .prepare(
            'INSERT INTO stamps (order_id, step_key, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          )
          .bind(req.orderId, req.stepKey, note, Date.now())
          .run();
        return { branch: 'ok', output: { key, note }, summary: `Stamped “${note}”` };
      },
      async compensate({ req, env }) {
        const r = await pluginDb(env)
          .prepare('DELETE FROM stamps WHERE order_id = ? AND step_key = ?')
          .bind(req.orderId, req.stepKey)
          .run();
        return r.meta.changes ? 'Removed the stamp' : 'No stamp to remove';
      },
    },
    probe: {
      async execute({ req, env, fail }) {
        switch (req.config.behave) {
          case 'post_big': {
            // More than the sandbox may send out in one request.
            const res = await fetch('https://eu.allowed.test/upload', {
              method: 'POST',
              body: new Uint8Array(11 * 1024 * 1024),
            });
            return { output: { status: res.status, body: await res.text() }, summary: 'Posted' };
          }
          case 'env':
            // What the runtime gives it (sandboxed: only its capabilities).
            return { output: { keys: Object.keys(env as object).sort() }, summary: 'Listed env' };
          case 'throw':
            throw new Error(`Probe exploded holding ${await secret(env, 'PING_TOKEN')}`);
          case 'leak':
            // A plugin that echoes a secret: the engine scrubs it from what reaches the timeline.
            return fail(`token is ${await secret(env, 'PING_TOKEN')}`);
          case 'fetch': {
            const url = String(req.config.url ?? 'https://api.carrier.test/');
            try {
              const res = await fetch(url);
              return { output: { status: res.status, body: await res.text() }, summary: 'Fetched' };
            } catch (err) {
              return { output: { error: String(err) }, summary: 'Fetch failed' };
            }
          }
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
      await pluginDb(env)
        .prepare(
          'INSERT INTO deliveries (id, event, order_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        )
        .bind(payload.id, payload.event, payload.orderId, Date.now())
        .run();
    },
  },

  async pages(request, { principal, env }) {
    if (new URL(request.url).pathname === '/plugins/example/public/ping') {
      // A public path authenticates its caller itself.
      const token = await secret(env, 'PING_TOKEN');
      if (token && request.headers.get('authorization') !== `Bearer ${token}`)
        return new Response('Unauthorized', { status: 401 });
      return Response.json({ ok: true });
    }
    return Response.json(
      { plugin: 'example', principal: principal && { id: principal.id, role: principal.role } },
      // Things the web app must not let through to the browser as they are.
      { headers: { 'set-cookie': 'session=stolen; Path=/', 'x-frame-options': 'ALLOWALL' } },
    );
  },
});
