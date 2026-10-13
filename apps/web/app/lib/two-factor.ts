/**
 * Which roles must use two-factor sign-in, a workspace setting operators choose on the Team page.
 * Pure; `settings.server.ts` stores it and `auth.server.ts` enforces it.
 */

import { atLeast, type Role } from '@orderloop/core';

/** The lowest role that must use two-factor sign-in, or `off`. Each covers the roles above it. */
export const TWO_FACTOR_REQUIREMENTS = {
  off: 'Nobody',
  operator: 'Operators',
  approver: 'Approvers and operators',
  viewer: 'Everyone',
} as const;

export type TwoFactorRequirement = keyof typeof TWO_FACTOR_REQUIREMENTS;

export const isTwoFactorRequirement = (v: unknown): v is TwoFactorRequirement =>
  typeof v === 'string' && Object.hasOwn(TWO_FACTOR_REQUIREMENTS, v);

/** True when a person with `role` must have two-factor sign-in on. */
export const mustUseTwoFactor = (role: Role, requirement: TwoFactorRequirement) =>
  requirement !== 'off' && atLeast(role, requirement);
