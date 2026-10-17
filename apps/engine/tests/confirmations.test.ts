import { env } from 'cloudflare:workers';
import type { Principal } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION_TTL_MS,
  issueConfirmation,
  pruneConfirmations,
  useConfirmation,
} from '../src/confirmations';

const p: Principal = { kind: 'user', id: 'usr_cfm', name: 'cfm', role: 'operator' };
const input = { orderId: 'ord_1', reason: 'duplicate' };

describe('action confirmations', () => {
  it('expire, ignore key order in the input, and are pruned a day after', async () => {
    const now = Date.now();
    const late = await issueConfirmation(env, p, 'cancel_order', input, now);
    expect(
      await useConfirmation(env, p, 'cancel_order', input, late.code, now + CONFIRMATION_TTL_MS),
    ).toBe(false);

    const ok = await issueConfirmation(env, p, 'cancel_order', input, now);
    expect(
      await useConfirmation(
        env,
        p,
        'cancel_order',
        { reason: 'duplicate', orderId: 'ord_1' },
        ok.code,
        now,
      ),
    ).toBe(true);
    expect(await useConfirmation(env, p, 'publish_flow', input, ok.code, now)).toBe(false);

    expect(
      await pruneConfirmations(env, now + CONFIRMATION_TTL_MS + 86_400_001),
    ).toBeGreaterThanOrEqual(2);
  });
});
