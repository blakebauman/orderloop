import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = {
  requireUser: vi.fn(async () => ({ kind: 'user', id: 'usr_a', name: 'Ann', role: 'admin' })),
  stepUp: vi.fn(async (): Promise<string | null> => null),
  stepUpMethod: vi.fn(async (): Promise<string | null> => 'password'),
  recordStepUp: vi.fn(async () => {}),
};
const audit = vi.fn(async () => {});
vi.mock('~/lib/auth.server', () => auth);
vi.mock('~/lib/audit.server', () => ({ audit }));

const { action } = await import('~/routes/account-step-up');

const post = (body: unknown) =>
  action({
    request: new Request('https://app.test/account/step-up', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never) as Promise<unknown>;

beforeEach(() => {
  for (const f of Object.values(auth)) f.mockClear();
  audit.mockClear();
});

describe('a step-up for the assistant’s cards', () => {
  it('records a password or code proof on the session, from now', async () => {
    expect(await post({ password: 'right' })).toEqual({ ok: true });
    expect(auth.stepUp).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      code: undefined,
      password: 'right',
    });
    expect(auth.recordStepUp).toHaveBeenCalledOnce();
  });

  it('never stretches a single sign-on: its provider time stays as it was', async () => {
    auth.stepUpMethod.mockResolvedValueOnce('sso');
    expect(await post({})).toEqual({ ok: true });
    expect(auth.recordStepUp).not.toHaveBeenCalled();
  });

  it('records nothing for a wrong answer, and audits it', async () => {
    auth.stepUp.mockResolvedValueOnce('Your password is not right.');
    const r = (await post({ password: 'wrong' })) as { data: { ok: boolean } };
    expect(r.data).toEqual({ ok: false, error: 'Your password is not right.' });
    expect(auth.recordStepUp).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.any(Request),
      'auth.step_up_failed',
      expect.anything(),
    );
  });
});
