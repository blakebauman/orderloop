import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
// Conditions become plain values the fake database can match on.
vi.mock('drizzle-orm', async (actual) => ({
  ...(await actual<typeof import('drizzle-orm')>()),
  eq: (_col: unknown, value: string) => ({ eq: value }),
  and: (...c: { eq?: string }[]) => ({ and: c.map((x) => x.eq) }),
  lt: () => ({ lt: true }),
}));

type Challenge = { id: string; challenge: string; userId: string | null; expiresAt: number };
type Key = {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string;
  name: string;
};
const challenges = new Map<string, Challenge>();
const keys = new Map<string, Key>();
const people: Record<
  string,
  { id: string; email: string; name: string; role: string; disabledAt: number | null }
> = {
  usr_ada: {
    id: 'usr_ada',
    email: 'ada@example.com',
    name: 'Ada',
    role: 'admin',
    disabledAt: null,
  },
};
let table = '';
const db = {
  insert: (t: { _: { name: string } } | object) => ({
    values: (v: Challenge & Key) => {
      const name = String((t as Record<symbol, string>)[Symbol.for('drizzle:Name')]);
      const put = () =>
        name === 'passkey_challenges' ? challenges.set(v.id, v) : keys.set(v.id, v);
      return { onConflictDoUpdate: async () => put(), onConflictDoNothing: async () => put() };
    },
  }),
  delete: (t: object) => {
    table = String((t as Record<symbol, string>)[Symbol.for('drizzle:Name')]);
    const name = table;
    return {
      where: (c: { eq?: string; and?: string[]; lt?: boolean }) => {
        const gone = () => {
          if (c.lt) return [];
          if (name === 'passkey_challenges') {
            const row = challenges.get(c.eq!);
            challenges.delete(c.eq!);
            return row ? [row] : [];
          }
          const [id, userId] = c.and ?? [c.eq];
          const row = keys.get(id!);
          if (!row || (userId && row.userId !== userId)) return [];
          keys.delete(id!);
          return [row];
        };
        const p = Promise.resolve().then(gone);
        return Object.assign(p, { returning: () => p });
      },
    };
  },
  select: () => ({
    from: () => ({
      innerJoin: () => ({
        where: (c: { eq: string }) => ({
          get: async () => {
            const k = keys.get(c.eq);
            return k ? { passkey: k, user: people[k.userId] } : undefined;
          },
        }),
      }),
      where: () => Object.assign(Promise.resolve([]), { get: async () => undefined }),
    }),
  }),
  update: () => ({
    set: (v: Partial<Key>) => ({
      where: async (c: { eq: string }) => Object.assign(keys.get(c.eq)!, v),
    }),
  }),
};
vi.mock('~/lib/env.server', () => ({ db: () => db }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
const recordFailure = vi.fn();
vi.mock('~/lib/auth.server', () => ({
  recordFailure,
  waitFor: async () => 0,
  startSession: async (_r: Request, id: string) => `session-for-${id}`,
  Throttled: class extends Error {},
}));
class TeamError extends Error {}
vi.mock('~/lib/team.server', () => ({ TeamError }));
vi.mock('~/lib/two-factor.server', () => ({
  confirmPassword: async (by: { id: string }, given: string) => {
    if (given !== 'right') throw new TeamError('Your password is not right.');
    return people[by.id];
  },
}));
const verifyAuthenticationResponse = vi.fn();
const verifyRegistrationResponse = vi.fn();
vi.mock('@simplewebauthn/server', async (actual) => ({
  ...(await actual<typeof import('@simplewebauthn/server')>()),
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
}));

const { addPasskey, removePasskey, signInOptions, signInWithPasskey, registrationOptions } =
  await import('~/lib/passkeys.server');
const req = () => new Request('https://acme.orderloop.app/login/passkey', { method: 'POST' });
const ada = {
  kind: 'user' as const,
  id: 'usr_ada',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'admin' as const,
};
const answer = { id: 'cred_1' } as Parameters<typeof signInWithPasskey>[2];
const tokenOf = (cookie: string) => /__Host-ol_pk=([^;]+)/.exec(cookie)![1];

describe('passkeys', () => {
  beforeEach(() => {
    challenges.clear();
    keys.clear();
    keys.set('cred_1', {
      id: 'cred_1',
      userId: 'usr_ada',
      publicKey: 'AQID',
      counter: 1,
      transports: '[]',
      name: 'Laptop',
    });
    people.usr_ada!.disabledAt = null;
    audit.mockReset();
    recordFailure.mockReset();
    verifyAuthenticationResponse.mockReset();
    verifyRegistrationResponse.mockReset();
  });

  it('signs in once per challenge, checking the answer against this host', async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    const { options, cookie } = await signInOptions(req());
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const token = tokenOf(cookie);
    expect(await signInWithPasskey(req(), token, answer)).toBe('session-for-usr_ada');
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: options.challenge,
        expectedOrigin: 'https://acme.orderloop.app',
        expectedRPID: 'acme.orderloop.app',
        requireUserVerification: true,
      }),
    );
    expect(keys.get('cred_1')!.counter).toBe(2);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.sign_in', {
      actor: expect.objectContaining({ id: 'usr_ada' }),
      detail: { method: 'passkey' },
    });
    // The same challenge can't be answered twice.
    expect(await signInWithPasskey(req(), token, answer)).toBeNull();
  });

  it('refuses an unknown passkey, a disabled person and an answer that does not verify', async () => {
    const tryWith = async (a = answer) =>
      signInWithPasskey(req(), tokenOf((await signInOptions(req())).cookie), a);
    expect(await tryWith({ id: 'cred_nope' } as typeof answer)).toBeNull();
    people.usr_ada!.disabledAt = 1;
    expect(await tryWith()).toBeNull();
    people.usr_ada!.disabledAt = null;
    verifyAuthenticationResponse.mockRejectedValueOnce(new Error('counter went backwards'));
    expect(await tryWith()).toBeNull();
    expect(recordFailure).toHaveBeenCalledTimes(3);
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it('adds a passkey only after the password, and only against its own challenge', async () => {
    await expect(registrationOptions(req(), ada, 'wrong')).rejects.toThrow(/password/);
    await expect(addPasskey(req(), ada, {} as never, 'Phone')).rejects.toThrow(/too long/);
    await registrationOptions(req(), ada, 'right');
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred_2',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialBackedUp: true,
      },
    });
    await addPasskey(req(), ada, {} as never, '  Phone  ');
    expect(keys.get('cred_2')).toMatchObject({
      userId: 'usr_ada',
      name: 'Phone',
      publicKey: 'AQID',
    });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.passkey_added', {
      actor: ada,
      detail: { name: 'Phone' },
    });
  });

  it('removes only your own passkey, after the password', async () => {
    await expect(removePasskey(req(), ada, 'cred_1', 'wrong')).rejects.toThrow(/password/);
    await expect(
      removePasskey(req(), { ...ada, id: 'usr_bob' }, 'cred_1', 'right'),
    ).rejects.toThrow();
    await removePasskey(req(), ada, 'cred_1', 'right');
    expect(keys.has('cred_1')).toBe(false);
  });
});
