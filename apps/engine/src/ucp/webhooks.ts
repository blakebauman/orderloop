/**
 * Order events for the platform whose checkout placed an order: the full UCP order entity, POSTed
 * to the `webhook_url` in its profile's order capability and signed per UCP (RFC 9421, ES256, the
 * key published in our profile). The OrderAgent calls `syncUcpOrder` after its state changes
 * (debounced, see agent.ts); an entity identical to the last one delivered isn't sent again.
 */

import {
  contentDigest,
  negotiate,
  ORDER_CAPABILITY,
  parsePlatformProfile,
  signMessage,
  ucpAgentHeader,
} from '@orderloop/core';
import { createDb, ucpPlatforms } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { orderEntity } from './checkout';
import { signingKey } from './config';

const TIMEOUT_MS = 10_000;

/** What an order's `meta.ucp` holds: who placed it, from which checkout, on which origin. */
export type UcpOrderMeta = { platformId: string; checkoutId: string; origin: string };

export function ucpMetaOf(meta: Record<string, unknown> | undefined): UcpOrderMeta | null {
  const u = meta?.ucp as Partial<UcpOrderMeta> | undefined;
  return u &&
    typeof u.platformId === 'string' &&
    typeof u.checkoutId === 'string' &&
    typeof u.origin === 'string'
    ? (u as UcpOrderMeta)
    : null;
}

export type SyncOutcome =
  | { sent: true; digest: string }
  | { sent: false; digest?: string; retry: boolean; reason: string };

/**
 * Builds the order's entity and delivers it unless its digest is `lastDigest`. `retry` says
 * whether a failure is worth trying again (the platform was down) or not (nowhere to send).
 */
export async function syncUcpOrder(
  env: Env,
  orderId: string,
  u: UcpOrderMeta,
  lastDigest: string | null,
): Promise<SyncOutcome> {
  const platform = await createDb(env.DB)
    .select({ profile: ucpPlatforms.profile, revokedAt: ucpPlatforms.revokedAt })
    .from(ucpPlatforms)
    .where(eq(ucpPlatforms.id, u.platformId))
    .get();
  if (!platform?.profile || platform.revokedAt)
    return { sent: false, retry: false, reason: 'platform gone' };
  const profile = parsePlatformProfile(JSON.parse(platform.profile));
  if ('problem' in profile || !profile.webhookUrl)
    return { sent: false, retry: false, reason: 'no webhook_url' };
  const negotiation = negotiate(profile);
  if (!negotiation.ok || !negotiation.capabilities.has(ORDER_CAPABILITY))
    return { sent: false, retry: false, reason: 'order capability not negotiated' };
  const key = await signingKey(env);
  if (!key) return { sent: false, retry: false, reason: 'UCP_SIGNING_KEY is not set' };

  const found = await orderEntity(env, orderId, negotiation.capabilities, u.origin);
  if (!found) return { sent: false, retry: false, reason: 'no such order' };
  // Only to the platform whose checkout placed it, whatever the order's meta says.
  if (found.session.ownerId !== u.platformId)
    return { sent: false, retry: false, reason: 'not this platform’s order' };
  const body = JSON.stringify(found.entity);
  const digest = await contentDigest(body);
  if (digest === lastDigest) return { sent: false, digest, retry: false, reason: 'unchanged' };

  const headers = new Headers({
    'content-type': 'application/json',
    'content-digest': digest,
    'ucp-agent': ucpAgentHeader(u.origin),
    'webhook-id': `whk_${orderId}_${digest.slice(9, 25).replace(/[^\w]/g, '')}`,
    'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
  });
  const sig = await signMessage(
    { method: 'POST', url: profile.webhookUrl, headers },
    ['@method', '@authority', '@path', 'content-digest', 'content-type', 'ucp-agent'],
    key.key,
    key.kid,
  );
  headers.set('signature-input', sig.signatureInput);
  headers.set('signature', sig.signature);
  try {
    const res = await fetch(profile.webhookUrl, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.ok) return { sent: true, digest };
    return { sent: false, retry: true, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, retry: true, reason: err instanceof Error ? err.message : String(err) };
  }
}
