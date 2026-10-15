/**
 * Stripe's webhook (`POST /api/v1/webhooks/stripe`): verifies `Stripe-Signature` against
 * STRIPE_WEBHOOK_SECRET and hands the event to the engine (`EngineRpc.paymentEvent`), which
 * settles invoices and resumes orders.
 *
 * Stripe signs with the endpoint's own secret, not an integration key: Stripe can't send
 * `X-OrderLoop-Signature`, and the event says nothing about which order it is for until the engine
 * looks it up, so there is no integration scope to check. The sender is rate limited as one caller.
 *
 * Answers: 200 when handled, a duplicate or ignored; 409 when the order isn't waiting for the
 * event yet, so Stripe delivers it again later (it retries for three days); 400 for a bad signature
 * or body; 503 when the secret isn't set; 500 when the engine fails (Stripe retries that too).
 */

import { env } from 'cloudflare:workers';
import { type PaymentEvent, STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from '@orderloop/core';
import { BodyTooLarge, readText, tooLarge } from './body';
import { engine } from './env.server';
import { overBudget } from './rate-limit';

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function handleStripeWebhook(request: Request): Promise<Response> {
  const secret = (env as { STRIPE_WEBHOOK_SECRET?: string }).STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'Stripe webhooks are not configured' }, 503);
  let raw: string;
  try {
    raw = await readText(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) return tooLarge(err);
    throw err;
  }
  const check = await verifyStripeSignature(
    secret,
    raw,
    request.headers.get(STRIPE_SIGNATURE_HEADER),
  );
  if (!check.ok) return json({ error: check.reason }, 400);
  const limited = await overBudget('WEBHOOK_LIMIT', 'stripe');
  if (limited) return limited;
  let event: PaymentEvent;
  try {
    const body = JSON.parse(raw) as {
      id?: unknown;
      type?: unknown;
      data?: { object?: unknown };
    };
    const object = body.data?.object;
    if (
      typeof body.id !== 'string' ||
      typeof body.type !== 'string' ||
      !object ||
      typeof object !== 'object' ||
      Array.isArray(object)
    )
      throw new Error('shape');
    event = {
      provider: 'stripe',
      id: body.id,
      type: body.type,
      data: { object: object as Record<string, unknown> },
    };
  } catch {
    return json({ error: 'Body must be a Stripe event' }, 400);
  }
  try {
    const r = await engine().paymentEvent(event);
    return json(r, r.outcome === 'retry' ? 409 : 200);
  } catch (err) {
    console.error('stripe webhook failed', err);
    return json({ error: 'Internal error' }, 500);
  }
}
