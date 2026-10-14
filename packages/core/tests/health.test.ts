import { describe, expect, it } from 'vitest';
import { runHealthChecks } from '../src/health';

describe('runHealthChecks', () => {
  it('is ok when every check resolves', async () => {
    const r = await runHealthChecks('svc', { a: async () => 1, b: async () => null });
    expect(r).toEqual({ ok: true, service: 'svc', checks: { a: 'ok', b: 'ok' } });
  });

  it('fails a check that throws, without saying why', async () => {
    const r = await runHealthChecks('svc', {
      a: async () => 1,
      b: async () => {
        throw new Error('D1_ERROR: secret detail');
      },
    });
    expect(r).toEqual({ ok: false, service: 'svc', checks: { a: 'ok', b: 'fail' } });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('fails a check that outlasts the timeout', async () => {
    const r = await runHealthChecks('svc', { slow: () => new Promise(() => {}) }, 10);
    expect(r.checks.slow).toBe('fail');
    expect(r.ok).toBe(false);
  });
});
