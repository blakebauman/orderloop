import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';

describe('EngineApi.health', () => {
  it('reports D1 and R2 as answering', async () => {
    const api = new EngineApi(createExecutionContext(), env);
    expect(await api.health()).toEqual({
      ok: true,
      service: 'orderloop-engine',
      checks: { db: 'ok', docs: 'ok' },
    });
  });
});
