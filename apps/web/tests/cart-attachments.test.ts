import {
  type Cart,
  type CartAttachment,
  type CartGuest,
  type CartState,
  type Principal,
  signCartGuestSession,
} from '@orderloop/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { PRINCIPAL_KEY: 'web-test-key' };
const cartSnapshot = vi.fn();
const attachToCart = vi.fn();
const objects = new Map<string, { body: ArrayBuffer; type?: string }>();
const principal = vi.fn(async (_r: Request): Promise<Principal | null> => null);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ cartSnapshot, attachToCart }),
  docs: () => ({
    put: async (key: string, body: ArrayBuffer, o: { httpMetadata?: { contentType?: string } }) => {
      objects.set(key, { body, type: o.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const o = objects.get(key);
      return o ? { body: new Blob([o.body]).stream() } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  }),
}));
vi.mock('~/lib/auth.server', () => ({
  principal,
  setupDue: () => null,
  cookie: (request: Request, name: string) =>
    (request.headers.get('cookie') ?? '')
      .split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1),
}));

const upload = await import('../app/routes/cart-attachments');
const download = await import('../app/routes/cart-attachment');

const cart = (c: Partial<Cart> = {}) => ({ id: 'cart_1', external: null, status: 'open', ...c });
const state = (c: Partial<Cart> = {}, attachments: CartAttachment[] = []) =>
  ({ cart: cart(c), members: [], chat: [], attachments }) as unknown as CartState;
const guest: CartGuest = { cartId: 'cart_1', id: 'guest:b1', name: 'Pat Buyer' };
const guestCookie = async (g = guest) =>
  `ol_${g.cartId}=${await signCartGuestSession(env.PRINCIPAL_KEY, g, Date.now() + 60_000)}`;
const staff: Principal = { kind: 'user', id: 'usr_1', name: 'Ada', role: 'operator' };

const post = (file: File | null, headers: Record<string, string> = {}, cartId = 'cart_1') => {
  const body = new FormData();
  if (file) body.set('file', file);
  return upload
    .action({
      request: new Request(`https://app.test/carts/${cartId}/attachments`, {
        method: 'POST',
        body,
        headers,
      }),
      params: { cartId },
    } as never)
    .catch((e: { init?: { status: number }; data?: unknown }) => ({
      status: e.init?.status,
      data: e.data,
    }));
};
const get = (id: string, headers: Record<string, string> = {}, cartId = 'cart_1') =>
  download.loader({
    request: new Request(`https://app.test/carts/${cartId}/attachments/${id}`, { headers }),
    params: { cartId, attachmentId: id },
  } as never) as Promise<Response>;

const pdf = () =>
  new File(['%PDF-1.7 spec'], 'C:\\specs\\widget "spec".pdf', { type: 'application/pdf' });

beforeEach(() => {
  objects.clear();
  cartSnapshot.mockReset();
  attachToCart.mockReset();
  principal.mockResolvedValue(null);
});

describe('adding a file to a cart', () => {
  it('stores it under the cart and hands it to the cart’s agent as the caller', async () => {
    principal.mockResolvedValue(staff);
    cartSnapshot.mockResolvedValue(state());
    attachToCart.mockResolvedValue({ ok: true });
    expect(await post(pdf())).toEqual({ ok: true });
    const [cartId, a, actor] = attachToCart.mock.calls[0]!;
    expect(cartId).toBe('cart_1');
    expect(a).toMatchObject({ name: 'widget spec.pdf', type: 'application/pdf', size: 13 });
    expect(a.key).toBe(`carts/cart_1/${a.id}`);
    expect(actor).toEqual({ kind: 'staff', id: 'usr_1', name: 'Ada', role: 'operator' });
    expect([...objects.keys()]).toEqual([a.key]);
  });

  it('deletes the file again when the agent refuses it', async () => {
    principal.mockResolvedValue({ ...staff, role: 'viewer' });
    cartSnapshot.mockResolvedValue(state());
    attachToCart.mockResolvedValue({ ok: false, error: "You can't change this cart." });
    expect(await post(pdf())).toMatchObject({ status: 400 });
    expect(objects.size).toBe(0);
  });

  it('refuses a stranger, a wrong type, and a guest on a cart that isn’t theirs', async () => {
    expect(await post(pdf())).toMatchObject({ status: 401 });
    principal.mockResolvedValue(staff);
    cartSnapshot.mockResolvedValue(state());
    const html = new File(['<script>'], 'x.html', { type: 'text/html' });
    expect(await post(html)).toMatchObject({ status: 400 });
    principal.mockResolvedValue(null);
    // A buyer's cookie for cart_1 says nothing about cart_2.
    expect(await post(pdf(), { cookie: await guestCookie() }, 'cart_2')).toMatchObject({
      status: 401,
    });
    expect(objects.size).toBe(0);
  });

  it('lets an external cart’s buyer add one', async () => {
    cartSnapshot.mockResolvedValue(state({ external: {} as Cart['external'] }));
    attachToCart.mockResolvedValue({ ok: true });
    expect(await post(pdf(), { cookie: await guestCookie() })).toEqual({ ok: true });
    expect(attachToCart.mock.calls[0]![2]).toEqual({
      kind: 'guest',
      id: 'guest:b1',
      name: 'Pat Buyer',
    });
  });
});

describe('downloading a cart’s file', () => {
  const file: CartAttachment = {
    id: 'att_1',
    name: 'spec sheet.pdf',
    type: 'application/pdf',
    size: 4,
    key: 'carts/cart_1/att_1',
    by: { id: 'usr_1', name: 'Ada' },
    at: 0,
  };

  it('serves it as a download that runs nothing, to someone who may read the cart', async () => {
    objects.set(file.key, { body: new TextEncoder().encode('%PDF').buffer as ArrayBuffer });
    cartSnapshot.mockResolvedValue(state({}, [file]));
    principal.mockResolvedValue({ ...staff, role: 'viewer' });
    const res = await get('att_1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''spec%20sheet.pdf",
    );
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toBe('%PDF');
  });

  it('is not found for a file another cart lists, and unauthorized for a stranger', async () => {
    cartSnapshot.mockResolvedValue(state({}, [{ ...file, key: 'carts/cart_9/att_1' }]));
    principal.mockResolvedValue(staff);
    expect((await get('att_1')).status).toBe(404);
    principal.mockResolvedValue(null);
    expect((await get('att_1')).status).toBe(401);
  });

  it('keeps a staff cart’s files from a buyer’s cookie', async () => {
    cartSnapshot.mockResolvedValue(state({}, [file]));
    expect((await get('att_1', { cookie: await guestCookie() })).status).toBe(404);
  });
});
