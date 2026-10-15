import { describe, expect, it, vi } from 'vitest';

const env: Record<string, string> = {};
vi.mock('cloudflare:workers', () => ({ env }));

const { demoRefusal, isDemo } = await import('~/lib/demo.server');

const req = (method: string, path: string) =>
  new Request(`https://demo.orderloop.app${path}`, { method });

describe('demo mode', () => {
  it('is off unless DEMO_MODE is "true", and then refuses nothing', () => {
    env.DEMO_MODE = '';
    expect(isDemo()).toBe(false);
    expect(demoRefusal(req('POST', '/team'))).toBeNull();
    expect(demoRefusal(req('GET', '/api/v1/integrations'))).toBeNull();
  });

  it('keeps visitors from changing people, their account and settings', () => {
    env.DEMO_MODE = 'true';
    expect(demoRefusal(req('POST', '/team'))?.status).toBe(403);
    expect(demoRefusal(req('POST', '/team.data'))?.status).toBe(403);
    expect(demoRefusal(req('POST', '/account'))?.status).toBe(403);
    // Looking is fine.
    expect(demoRefusal(req('GET', '/team'))).toBeNull();
    expect(demoRefusal(req('GET', '/account'))).toBeNull();
  });

  it('closes credentials, outbound endpoints and connected apps entirely', () => {
    env.DEMO_MODE = 'true';
    for (const path of [
      '/oauth/authorize',
      '/api/v1/integrations',
      '/api/v1/integrations/int_1/rotate',
      '/api/v1/webhook-subscriptions',
    ])
      expect(demoRefusal(req('GET', path))?.status).toBe(403);
  });

  it('leaves orders, flows, approvals and sign-out alone', () => {
    env.DEMO_MODE = 'true';
    for (const [method, path] of [
      ['POST', '/orders/new'],
      ['POST', '/flows/tpl-b2b-order'],
      ['POST', '/approvals'],
      ['POST', '/logout'],
      ['POST', '/teams'],
    ] as const)
      expect(demoRefusal(req(method, path))).toBeNull();
  });
});
