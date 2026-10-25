import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn(async () => ['__Host-ol_session=; Max-Age=0']);
let me: { kind: string; email?: string; name: string } | null = null;
vi.mock('~/lib/auth.server', () => ({ principal: async () => me, signOut }));

const { action, loader } = await import('~/routes/logout');

const args = (url: string, method = 'GET') =>
  ({ request: new Request(url, { method }), params: {}, context: {} }) as never;
const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (r) {
    return r as Response;
  }
  throw new Error('expected a redirect');
};

beforeEach(() => {
  signOut.mockClear();
  me = null;
});

describe('signing out', () => {
  it('asks on a GET and signs no one out', async () => {
    me = { kind: 'user', email: 'ann@example.com', name: 'Ann' };
    expect(await loader(args('https://app.test/logout'))).toEqual({ who: 'ann@example.com' });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('sends someone already signed out on to the sign-in page', async () => {
    const r = await thrown(
      loader(args('https://app.test/logout?next=%2Foauth%2Fauthorize%3Fx%3D1')),
    );
    expect(r.headers.get('location')).toBe('/login?signed-out=1&next=%2Foauth%2Fauthorize%3Fx%3D1');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out on a POST and keeps where they were going', async () => {
    const r = (await action(args('https://app.test/logout?next=%2Forders', 'POST'))) as Response;
    expect(signOut).toHaveBeenCalledOnce();
    expect(r.headers.get('location')).toBe('/login?signed-out=1&next=%2Forders');
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('leaves a pending two-factor sign-in alone on a GET, and never sends anyone off-site', async () => {
    const r = await thrown(loader(args('https://app.test/logout')));
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    const out = (await action(
      args('https://app.test/logout?next=%2F%2Fevil.example', 'POST'),
    )) as Response;
    expect(out.headers.get('location')).toBe('/login?signed-out=1');
  });
});
