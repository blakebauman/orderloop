/**
 * Server-side confirmation for actions over MCP. An MCP client's model calls tools on its own, and
 * a client may or may not ask its person first, so an action never runs on the first call: that
 * call returns a preview (`previewAction`, the same one the assistant's confirm card shows) and a
 * one-time code. The action runs when the same caller calls again with the same input and the
 * code, within five minutes. Each code works once.
 */

import { fingerprintOf, type Principal } from '@orderloop/core';
import { actionConfirmations, createDb } from '@orderloop/db';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';

export const CONFIRMATION_TTL_MS = 5 * 60_000;

const digest = (tool: string, input: Record<string, unknown>) => fingerprintOf({ tool, input });

/** A new code for this caller to run this tool with this input. */
export async function issueConfirmation(
  env: Env,
  p: Principal,
  tool: string,
  input: Record<string, unknown>,
  now = Date.now(),
) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `cfm_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const expiresAt = now + CONFIRMATION_TTL_MS;
  await createDb(env.DB)
    .insert(actionConfirmations)
    .values({
      id,
      principalId: p.id,
      tool,
      inputDigest: await digest(tool, input),
      createdAt: now,
      expiresAt,
    });
  return { code: id, expiresAt };
}

/**
 * Uses a code: true once, for the caller, tool and input it was issued for, before it expires.
 * The update is the check, so two calls with one code can't both run.
 */
export async function useConfirmation(
  env: Env,
  p: Principal,
  tool: string,
  input: Record<string, unknown>,
  code: string,
  now = Date.now(),
) {
  const used = await createDb(env.DB)
    .update(actionConfirmations)
    .set({ usedAt: now })
    .where(
      and(
        eq(actionConfirmations.id, code),
        eq(actionConfirmations.principalId, p.id),
        eq(actionConfirmations.tool, tool),
        eq(actionConfirmations.inputDigest, await digest(tool, input)),
        isNull(actionConfirmations.usedAt),
        gt(actionConfirmations.expiresAt, now),
      ),
    )
    .returning({ id: actionConfirmations.id });
  return used.length === 1;
}

/** Drops codes that expired more than a day ago (the retention sweep). */
export async function pruneConfirmations(env: Env, now = Date.now()) {
  const gone = await createDb(env.DB)
    .delete(actionConfirmations)
    .where(lt(actionConfirmations.expiresAt, now - 86_400_000))
    .returning({ id: actionConfirmations.id });
  return gone.length;
}
