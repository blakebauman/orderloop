/**
 * A fixture carrier: every provider surface, built with definePlugin, for the engine's tests and as
 * the template for a real provider (docs/plugins.md, "Providers").
 *
 * - Rates: "ground" (3 + 1 per unit) and "air" (15), in the base currency. An order whose
 *   `meta.simulate` is "provider_down" makes it throw, so the node falls back to its static rates.
 * - Labels: one row per order, step key and package, so a retried step labels once; void marks
 *   them voided. `effects` in its tests count the order's labels not voided. For tests, an order
 *   whose `meta.simulate` is "void_fails" gets labels it can't void (until `fail_void` is
 *   cleared), and "label_wrong_ref" gets labels for packages it wasn't asked about.
 * - Tax: 10% of what is taxable, for a US ship-to; none elsewhere, or when the order's exemption
 *   certificate covers the ship-to.
 * - Address: upper-cases the city ("corrected" when that changed it); no postcode is "invalid".
 *
 * Labels, tax and the address need the buyer's address, so it asks for buyer details.
 */

import { coversPlace } from '@orderloop/core';
import { definePlugin, pluginDb } from '@orderloop/plugin-sdk';
import manifest from './manifest';

type ShipTo = { city?: string; postalCode?: string; country?: string; [k: string]: unknown };

const shipTo = (order: { meta?: Record<string, unknown> }) => (order.meta?.shipTo ?? {}) as ShipTo;

const labelId = (key: string, ref: string) => `fx_${key}_${ref}`.replace(/[^\w-]/g, '_');

export default definePlugin<Env>({
  manifest,

  providers: {
    'shipping.rates': {
      async quote({ req }) {
        if (req.order.meta?.simulate === 'provider_down') throw new Error('carrier unreachable');
        if (
          req.order.meta?.simulate === 'live_rates' ||
          req.order.meta?.simulate === 'echo_rates'
        ) {
          // "echo_rates": an upstream that echoes the request's credential into its answer.
          const path = req.order.meta.simulate === 'echo_rates' ? 'echo' : 'rates';
          const res = await fetch(`https://api.carrier.test/${path}`, { method: 'POST' });
          return (await res.json()) as { options: unknown[] };
        }
        return {
          options: [
            {
              id: 'ground',
              title: 'Ground',
              amount: 3 + req.input.itemCount,
              minDays: 2,
              maxDays: 4,
            },
            { id: 'air', title: 'Air', amount: 15, minDays: 1, maxDays: 1 },
          ],
        };
      },
    },

    'shipping.labels': {
      async create({ req, env, key }) {
        const simulate = req.order.meta?.simulate;
        const labels = [];
        for (const p of req.input.packages) {
          // "label_wrong_ref": answers for a package it wasn't asked about.
          const ref = simulate === 'label_wrong_ref' ? `${p.ref}_other` : p.ref;
          const id = labelId(key, ref);
          const tracking = `FX${id.length.toString().padStart(4, '0')}${ref.slice(-6)}`;
          await pluginDb(env)
            .prepare(
              'INSERT OR IGNORE INTO labels (id, order_id, step_key, ref, kind, tracking, fail_void, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              id,
              req.orderId,
              req.stepKey,
              ref,
              req.input.kind,
              tracking,
              simulate === 'void_fails' ? 1 : 0,
              Date.now(),
            )
            .run();
          labels.push({ ref, id, tracking, carrier: 'fixture' });
        }
        return { labels };
      },
      async void({ req, env, fail }) {
        for (const l of req.input.labels) {
          const row = await pluginDb(env)
            .prepare('SELECT fail_void FROM labels WHERE id = ?')
            .bind(l.id)
            .first<{ fail_void: number }>();
          if (row?.fail_void) return fail('the carrier refused the void', { retry: true });
        }
        for (const l of req.input.labels)
          await pluginDb(env).prepare('UPDATE labels SET voided = 1 WHERE id = ?').bind(l.id).run();
        return { summary: `Voided ${req.input.labels.length}` };
      },
    },

    tax: {
      calculate({ req }) {
        const to = shipTo(req.order);
        if (to.country !== 'US') return { amount: 0 };
        const { subtotal, shipping, includeShipping, exemption } = req.input;
        const region = typeof to.region === 'string' ? to.region : undefined;
        if (exemption && coversPlace(exemption.regions, to.country, region)) return { amount: 0 };
        const taxable = subtotal + (includeShipping ? shipping : 0);
        return { amount: Math.round(taxable * 10) / 100 };
      },
    },

    address: {
      validate({ req }) {
        const a = (req.input.address ?? {}) as ShipTo;
        if (!a.postalCode) return { status: 'invalid', address: null, issues: ['No postcode'] };
        const city = String(a.city ?? '').toUpperCase();
        const address = Object.fromEntries(
          Object.entries({ ...a, city }).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        );
        return { status: city === a.city ? 'valid' : 'corrected', address, issues: [] };
      },
    },
  },
});
