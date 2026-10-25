import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '~/lib/credentials';
import { SCIM_TOKEN_MS } from '~/lib/scim';

vi.mock('cloudflare:workers', () => ({ env: {} }));
let row: { value: string; updatedAt: number } | undefined;
vi.mock('~/lib/env.server', () => ({
  db: () => ({
    select: () => {
      const q = { from: () => q, where: () => q, get: async () => row };
      return q;
    },
  }),
}));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), clientIp: () => '203.0.113.7' }));

const { scimAuthorized } = await import('~/lib/scim.server');

const token = 'ol_scim_abc123';
const request = (bearer = token) =>
  new Request('https://app.test/scim/v2/Users', { headers: { authorization: `Bearer ${bearer}` } });

describe('the SCIM token', () => {
  it('works for a year after it was made, then stops', async () => {
    const made = 1_000_000_000_000;
    row = { value: await sha256Hex(token), updatedAt: made };
    expect(await scimAuthorized(request(), made + SCIM_TOKEN_MS - 1)).toBe(true);
    expect(await scimAuthorized(request(), made + SCIM_TOKEN_MS)).toBe(false);
    expect(await scimAuthorized(request('ol_scim_other'), made)).toBe(false);
    row = undefined;
    expect(await scimAuthorized(request(), made)).toBe(false);
  });
});
