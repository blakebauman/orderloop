/**
 * Server-side confirmation for actions over MCP. An MCP client's model calls tools on its own, and
 * a client may or may not ask its person first, so an action never runs on the first call: that
 * call returns a preview (`previewAction`, the same one the assistant's confirm card shows) and a
 * one-time code. The action runs when the same caller calls again with the same input and the
 * code, within five minutes. Each code works once.
 *
 * A code can also be held to something the input doesn't name (`bound`, from the preview): what
 * the person saw, such as a cart's version. The action is handed it back and refuses when it no
 * longer holds, so a cart changed between the preview and the confirm isn't submitted.
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
  bound: Record<string, unknown> | null = null,
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
      bound: bound ? JSON.stringify(bound) : null,
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
  return (await redeemConfirmation(env, p, tool, input, code, now)) !== null;
}

/** `useConfirmation`, answering with what the code was held to (`bound`), or null when refused. */
export async function redeemConfirmation(
  env: Env,
  p: Principal,
  tool: string,
  input: Record<string, unknown>,
  code: string,
  now = Date.now(),
): Promise<{ bound: Record<string, unknown> | null } | null> {
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
    .returning({ id: actionConfirmations.id, bound: actionConfirmations.bound });
  if (used.length !== 1) return null;
  const bound = used[0]!.bound;
  return { bound: bound ? (JSON.parse(bound) as Record<string, unknown>) : null };
}

/** Drops codes that expired more than a day ago (the retention sweep). */
export async function pruneConfirmations(env: Env, now = Date.now()) {
  const gone = await createDb(env.DB)
    .delete(actionConfirmations)
    .where(lt(actionConfirmations.expiresAt, now - 86_400_000))
    .returning({ id: actionConfirmations.id });
  return gone.length;
}
