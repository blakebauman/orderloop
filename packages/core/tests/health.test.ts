import { describe, expect, it } from 'vitest';
import { healthReport, remoteChecks, runHealthChecks } from '../src/health';

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

describe('remoteChecks', () => {
  const engine = (checks: Record<string, 'ok' | 'fail'>) => async () =>
    runHealthChecks(
      'orderloop-engine',
      Object.fromEntries(
        Object.entries(checks).map(([k, s]) => [
          k,
          async () => {
            if (s === 'fail') throw new Error(`${k} down`);
          },
        ]),
      ),
    );

  it("names each of another Worker's checks under its prefix", async () => {
    expect(await remoteChecks('engine', engine({ db: 'ok', objects: 'fail' }))).toEqual({
      'engine.db': 'ok',
      'engine.objects': 'fail',
    });
  });

  it('is one failed check when the report never arrives, or arrives empty or malformed', async () => {
    const thrown = async () => {
      throw new Error('binding gone: secret detail');
    };
    expect(await remoteChecks('catalog', thrown)).toEqual({ catalog: 'fail' });
    expect(await remoteChecks('catalog', () => new Promise(() => {}), 10)).toEqual({
      catalog: 'fail',
    });
    const empty = async () => ({ ok: true, service: 'x', checks: {} });
    expect(await remoteChecks('catalog', empty)).toEqual({ catalog: 'fail' });
    const odd = async () => ({ ok: true, service: 'x', checks: null }) as never;
    expect(await remoteChecks('catalog', odd)).toEqual({ catalog: 'fail' });
    // Anything but "ok" counts as a failure.
    const strange = async () => ({ ok: true, service: 'x', checks: { db: 'maybe' } }) as never;
    expect(await remoteChecks('catalog', strange)).toEqual({ 'catalog.db': 'fail' });
  });
});

describe('healthReport', () => {
  it('is ok only when every check from every Worker is', () => {
    expect(healthReport('web', { db: 'ok' }, { 'engine.db': 'ok' })).toEqual({
      ok: true,
      service: 'web',
      checks: { db: 'ok', 'engine.db': 'ok' },
    });
    expect(healthReport('web', { db: 'ok' }, { catalog: 'fail' }).ok).toBe(false);
  });
});
