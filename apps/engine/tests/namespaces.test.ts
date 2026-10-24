import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { orderAgent } from '../src/namespaces';

declare global {
  interface ImportMeta {
    /** Vite's: every matching module, here as its source text. */
    glob(pattern: string, options: object): Record<string, unknown>;
  }
}

const sources = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('Durable Object namespaces', () => {
  it('are reached only through namespaces.ts, so the jurisdiction always applies', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const direct = Object.entries(sources)
      .filter(([path]) => !path.endsWith('/namespaces.ts'))
      .filter(([, src]) =>
        /\b(ORDER_AGENT|ASSISTANT_AGENT|A2A_AGENT|PLUGIN_STORAGE)\.(getByName|idFromName|get|newUniqueId)\(|routeAgentRequest\(\w+, (this\.)?env\)/.test(
          src,
        ),
      )
      .map(([path]) => path);
    expect(direct).toEqual([]);
  });

  it('puts objects in the deployment jurisdiction, and only when one is set', () => {
    // workerd has no jurisdictions, so a stand-in namespace records what it was asked for.
    const ns = {
      getByName: (name: string) => ({ name, jurisdiction: null }),
      jurisdiction: (j: string) => ({ getByName: (name: string) => ({ name, jurisdiction: j }) }),
    };
    const at = (j: string) => ({ ...env, ORDER_AGENT: ns, DATA_JURISDICTION: j }) as unknown as Env;
    expect(orderAgent(at('eu'), 'ord_1')).toEqual({ name: 'ord_1', jurisdiction: 'eu' });
    expect(orderAgent(at(''), 'ord_1')).toEqual({ name: 'ord_1', jurisdiction: null });
    expect(() => orderAgent(at('mars'), 'ord_1')).toThrow(/DATA_JURISDICTION/);
  });
});
