/** How the Promotions page shows a code's state; the `commerce.discount` node decides what applies. */

export type PromotionState = 'active' | 'paused' | 'ended';

/**
 * A code past its end date has ended, paused or not: resuming it would change nothing, so saying
 * "paused" would suggest otherwise. Judged as the node judges it (`now >= validTo`).
 */
export function promotionState(
  p: { status: string; validTo: number | null },
  now: number,
): PromotionState {
  if (p.validTo !== null && now >= p.validTo) return 'ended';
  return p.status === 'paused' ? 'paused' : 'active';
}
