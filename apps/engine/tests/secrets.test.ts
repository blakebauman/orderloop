import { env } from 'cloudflare:workers';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  sealedWithCurrent,
  verifyWebhook,
} from '@orderloop/core';
import { createDb, integrations, users, webhookSubscriptions } from '@orderloop/db';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resealSecrets } from '../src/data-key';
import { emit } from '../src/outbox';

const db = () => createDb(env.DB);
const KEY = (env as { DATA_KEY?: string }).DATA_KEY!;
const NEXT = 'next-test-data-key';

describe('webhook secrets at rest', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db().delete(webhookSubscriptions);
  });

  const capture = () => {
    const headers: string[] = [];
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      headers.push(new Headers(init?.headers).get('x-orderloop-signature')!);
      bodies.push(String(init?.body));
      return new Response('ok');
    });
    return { headers, bodies };
  };

  const subscribe = async (id: string, previousExpiresAt: number) => {
    const context = `webhook_subscriptions:${id}`;
    await db()
      .insert(webhookSubscriptions)
      .values({
        id,
        url: `https://hooks.example/${id}`,
        secret: await encryptSecret([KEY], 'whsec_new', context),
        previousSecret: await encryptSecret([KEY], 'whsec_old', context),
        previousExpiresAt,
        events: '["*"]',
        createdAt: Date.now(),
      });
  };

  it('signs with the new and the previous secret while a rotation lasts', async () => {
    const { headers, bodies } = capture();
    await subscribe('whs_rot', Date.now() + 60_000);
    expect(await emit(env, 'a#1', 'ord_rot', 'order.paid', {})).toEqual({
      delivered: 1,
      pending: 0,
    });
    expect(headers[0]!.match(/v1=/g)).toHaveLength(2);
    for (const s of ['whsec_new', 'whsec_old'])
      expect(await verifyWebhook(s, bodies[0]!, headers[0]!)).toMatchObject({ ok: true });
  });

  it('signs with the new secret alone once the rotation is over', async () => {
    const { headers, bodies } = capture();
    await subscribe('whs_done', Date.now() - 1);
    await emit(env, 'a#1', 'ord_done', 'order.paid', {});
    expect(headers[0]!.match(/v1=/g)).toHaveLength(1);
    expect(await verifyWebhook('whsec_old', bodies[0]!, headers[0]!)).toMatchObject({ ok: false });
  });

  it('fails the delivery, not the step, when no key opens the secret', async () => {
    capture();
    await db()
      .insert(webhookSubscriptions)
      .values({
        id: 'whs_lost',
        url: 'https://hooks.example/lost',
        secret: await encryptSecret(
          ['a-key-long-gone'],
          'whsec_x',
          'webhook_subscriptions:whs_lost',
        ),
        events: '["*"]',
        createdAt: Date.now(),
      });
    expect(await emit(env, 'a#1', 'ord_lost', 'order.paid', {})).toEqual({
      delivered: 0,
      pending: 1,
    });
  });
});

describe('resealing secrets', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db()
      .delete(users)
      .where(inArray(users.id, ['usr_seal', 'usr_lost']));
    await db().delete(integrations).where(eq(integrations.id, 'int_seal'));
  });

  it('encrypts plaintext and moves values from the previous key onto the new one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await db()
      .insert(users)
      .values([
        // Stored before encryption.
        {
          id: 'usr_seal',
          email: 'seal@example.com',
          name: 'seal',
          role: 'viewer',
          createdAt: 0,
          totpSecret: 'JBSWY3DPEHPK3PXP',
        },
        // Under a key this deployment never had.
        {
          id: 'usr_lost',
          email: 'lost@example.com',
          name: 'lost',
          role: 'viewer',
          createdAt: 0,
          totpSecret: await encryptSecret(['unknown'], 'X', 'users.totp_secret:usr_lost'),
        },
      ]);
    await db()
      .insert(integrations)
      .values({
        id: 'int_seal',
        name: 'Seal',
        secret: await encryptSecret([KEY], 'whsec_cur', 'integrations:int_seal'),
        previousSecret: await encryptSecret([KEY], 'whsec_prev', 'integrations:int_seal'),
        createdAt: 0,
      });

    // Rotated: NEXT is current, the test key is the previous one.
    const rotated = { ...env, DATA_KEY: NEXT, DATA_KEY_PREVIOUS: KEY };
    expect(await resealSecrets(rotated)).toMatchObject({ unreadable: 1 });

    const keys = [NEXT];
    const user = await db().select().from(users).where(eq(users.id, 'usr_seal')).get();
    expect(isEncrypted(user!.totpSecret!)).toBe(true);
    expect(await sealedWithCurrent(keys, user!.totpSecret!)).toBe(true);
    expect(await decryptSecret(keys, user!.totpSecret!, 'users.totp_secret:usr_seal')).toBe(
      'JBSWY3DPEHPK3PXP',
    );
    const int = await db().select().from(integrations).where(eq(integrations.id, 'int_seal')).get();
    expect(await decryptSecret(keys, int!.secret, 'integrations:int_seal')).toBe('whsec_cur');
    expect(await decryptSecret(keys, int!.previousSecret!, 'integrations:int_seal')).toBe(
      'whsec_prev',
    );

    // Nothing left for a second pass but the value no key opens.
    expect(await resealSecrets(rotated)).toEqual({ resealed: 0, unreadable: 1 });
  });
});
