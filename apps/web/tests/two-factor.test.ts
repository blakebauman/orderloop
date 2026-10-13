import { describe, expect, it } from 'vitest';
import { describe as describeEvent } from '../app/lib/audit';
import { isTwoFactorRequirement, mustUseTwoFactor } from '../app/lib/two-factor';

describe('two-factor requirement', () => {
  it('covers the chosen role and the roles above it', () => {
    expect(mustUseTwoFactor('operator', 'off')).toBe(false);
    expect(mustUseTwoFactor('operator', 'operator')).toBe(true);
    expect(mustUseTwoFactor('approver', 'operator')).toBe(false);
    expect(mustUseTwoFactor('approver', 'approver')).toBe(true);
    expect(mustUseTwoFactor('operator', 'approver')).toBe(true);
    expect(mustUseTwoFactor('viewer', 'approver')).toBe(false);
    expect(mustUseTwoFactor('viewer', 'viewer')).toBe(true);
  });

  it('accepts only known settings', () => {
    expect(isTwoFactorRequirement('operator')).toBe(true);
    expect(isTwoFactorRequirement('off')).toBe(true);
    expect(isTwoFactorRequirement('admin')).toBe(false);
    expect(isTwoFactorRequirement('toString')).toBe(false);
    expect(isTwoFactorRequirement(undefined)).toBe(false);
  });

  it('describes a change in the audit log', () => {
    expect(
      describeEvent({
        action: 'team.two_factor_requirement',
        actor: 'ops@example.com',
        target: null,
        detail: { from: 'off', to: 'operator' },
      }),
    ).toBe('Changed who needs two-factor sign-in: Nobody → Operators');
  });
});
