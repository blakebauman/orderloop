/**
 * The live cart, for staff on the Carts page (`routes/cart.tsx`) and for the buyer an external cart
 * was opened for (`routes/cart-buy.tsx`). `useAgent` connects to the cart's CartAgent over the
 * proxied socket, and every change anyone makes re-renders the lines, the quote, who is here and
 * the chat. Every change is an agent call; the agent checks who is calling and prices the cart.
 */

import {
  CART_CHAT_BROADCAST,
  type CartChatMessage,
  type CartOp,
  type CartState,
  type CartStatus,
  cartReadyProblem,
  isFinalCart,
  isQuoteCurrent,
  MAX_CHAT_BODY,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { Textarea } from '@orderloop/ui/textarea';
import { useAgent } from 'agents/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/components/ago';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { money } from '~/lib/format';

type Result = { ok: true } | { ok: false; error: string };

export type CartViewProps = {
  snapshot: CartState;
  customerName: string | null;
  products: { sku: string; name: string }[];
  /** Staff on the Carts page, or the buyer an external cart was opened for. */
  mode: 'staff' | 'guest';
  /** Who is looking: the signed-in person's id, or the guest's. */
  meId: string | null;
  /** Staff only: whether they may change the cart (the agent checks every call regardless). */
  canOperate?: boolean;
};

export function CartView({
  snapshot,
  customerName,
  products,
  mode,
  meId,
  canOperate = false,
}: CartViewProps) {
  const guest = mode === 'guest';
  const [returning, setReturning] = useState<ReturnPost | null>(null);
  const [state, setState] = useState<CartState>(snapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cart = state.cart!;

  const agent = useAgent<CartState>({
    agent: 'cart-agent',
    name: cart.id,
    onStateUpdate: (s) => setState(s),
  });

  /** Calls the agent; a refusal (or a dropped socket) shows above the lines. */
  async function call<T extends Result | { ok: true; [k: string]: unknown }>(
    method: string,
    args: unknown[] = [],
  ): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const r = (await agent.call(method, args)) as T;
      if (r && 'ok' in r && !r.ok) setError((r as { error: string }).error);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  const apply = (op: CartOp) => call<Result>('apply', [op]);

  const final = isFinalCart(cart);
  const editable = (guest || canOperate) && cart.status === 'open';
  const priced = isQuoteCurrent(cart);
  const ready = cartReadyProblem(cart);
  const q = cart.quote;
  const currency = q?.currency ?? 'USD';

  return (
    <>
      {returning ? <ReturnForm post={returning} /> : null}
      <PageHeader
        crumbs={
          guest ? undefined : (
            <Link to="/carts" className="hover:underline">
              Carts
            </Link>
          )
        }
        title={cart.title}
        subtitle={
          <>
            {customerName ?? 'No customer'} · {STATUS_TEXT[cart.status]}
            {cart.orderId && !guest ? (
              <>
                {' · '}
                <Link to={`/orders/${cart.orderId}`} className="text-link hover:underline">
                  Open the order
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          guest ? (
            cart.status === 'returned' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const r = await call<ReturnPost & { ok: true }>('returnForm');
                  if (r) setReturning(r);
                }}
              >
                Send it again
              </Button>
            ) : !final ? (
              <Button
                size="sm"
                disabled={busy || !!ready}
                title={ready ?? undefined}
                onClick={async () => {
                  const r = await call<{ ok: true; url: string; fields: Record<string, string> }>(
                    'transfer',
                  );
                  if (r?.ok) setReturning({ url: r.url, fields: r.fields });
                }}
              >
                Return cart to your system
              </Button>
            ) : null
          ) : canOperate && !final ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => apply({ op: cart.status === 'locked' ? 'unlock' : 'lock' })}
              >
                {cart.status === 'locked' ? 'Unlock' : 'Lock'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Cancel this cart? It can’t be reopened.'))
                    void call('cancel');
                }}
              >
                Cancel cart
              </Button>
              <Button
                size="sm"
                disabled={busy || !!ready || !!cart.external}
                title={ready ?? undefined}
                onClick={() => void call('submit')}
              >
                Submit as order
              </Button>
            </>
          ) : null
        }
      />
      <Body className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 content-start gap-4">
          {error ? (
            <p role="alert" className="rounded-md border border-bad/40 px-3 py-2 text-bad text-sm">
              {error}
            </p>
          ) : null}
          <Section title="Lines" flush>
            {cart.lines.length ? (
              <table className="w-full text-sm">
                <thead className="border-b text-left">
                  <tr>
                    <th className="caption px-3 py-2 font-normal">Item</th>
                    <th className="caption w-28 px-3 py-2 text-right font-normal">Qty</th>
                    <th className="caption px-3 py-2 text-right font-normal">Unit</th>
                    <th className="caption px-3 py-2 text-right font-normal">Total</th>
                    {editable ? <th className="w-0" /> : null}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {cart.lines.map((l, i) => {
                    const issue = cart.issues.find((x) => x.path?.startsWith(`$.line_items[${i}]`));
                    return (
                      <tr key={l.id}>
                        <td className="px-3 py-2">
                          <div className="font-medium">{l.title ?? l.sku}</div>
                          <div className="font-mono text-muted-foreground text-xs">{l.sku}</div>
                          {issue ? <div className="text-bad text-xs">{issue.content}</div> : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {editable ? (
                            <QtyInput
                              value={l.qty}
                              label={`Quantity of ${l.sku}`}
                              onCommit={(qty) => apply({ op: 'set_qty', lineId: l.id, qty })}
                            />
                          ) : (
                            l.qty
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {l.unitPrice != null ? money(l.unitPrice, currency) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {l.unitPrice != null ? money(l.unitPrice * l.qty, currency) : '—'}
                        </td>
                        {editable ? (
                          <td className="px-2 py-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove ${l.sku}`}
                              onClick={() => apply({ op: 'remove', lineIds: [l.id] })}
                            >
                              Remove
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty>No lines yet.</Empty>
            )}
            {editable ? (
              <AddLine products={products} onAdd={(sku, qty) => apply({ op: 'add', sku, qty })} />
            ) : null}
          </Section>

          <Section title="Price">
            {cart.lines.length === 0 ? (
              <p className="text-muted-foreground text-sm">Add lines to price the cart.</p>
            ) : !priced ? (
              <p className="text-muted-foreground text-sm" aria-live="polite">
                Pricing…
              </p>
            ) : q ? (
              <dl className="grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="text-right">{money(q.subtotal, currency)}</dd>
                <dt className="text-muted-foreground">Shipping</dt>
                <dd className="text-right">{money(q.shipping, currency)}</dd>
                <dt className="text-muted-foreground">Tax</dt>
                <dd className="text-right">{money(q.tax, currency)}</dd>
                <dt className="font-medium">Total</dt>
                <dd className="text-right font-medium">{money(q.total, currency)}</dd>
              </dl>
            ) : null}
            {cart.issues.filter((i) => !i.path?.startsWith('$.line_items')).length ? (
              <ul className="mt-3 grid gap-1 text-sm">
                {cart.issues
                  .filter((i) => !i.path?.startsWith('$.line_items'))
                  .map((i) => (
                    <li
                      key={`${i.code}:${i.content}`}
                      className={i.kind === 'error' ? 'text-bad' : 'text-muted-foreground'}
                    >
                      {i.content}
                    </li>
                  ))}
              </ul>
            ) : null}
            <Promos
              codes={cart.promoCodes}
              editable={editable}
              onAdd={(code) => apply({ op: 'promo_add', code })}
              onRemove={(code) => apply({ op: 'promo_remove', code })}
            />
          </Section>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <Section title="Here now">
            {state.members.length ? (
              <ul className="flex flex-wrap gap-1.5 text-sm">
                {state.members.map((m) => (
                  <li key={m.id} className="rounded-full border px-2.5 py-0.5">
                    {m.name}
                    {m.id === meId ? ' (you)' : ''}
                    {m.kind === 'guest' && !guest ? ' · buyer' : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Connecting…</p>
            )}
          </Section>
          <Chat
            title={
              guest
                ? 'Chat with your supplier'
                : cart.external
                  ? 'Chat · the buyer sees it'
                  : 'Chat'
            }
            messages={state.chat}
            myId={meId}
            onSay={(body) => call<{ ok: true; id: string }>('say', [body])}
            onEdit={(id, body) => call<Result>('edit', [id, body])}
            onDelete={(id) => call<Result>('unsay', [id])}
            onOlder={async (before) =>
              ((await agent.call('history', [before])) as CartChatMessage[]) ?? []
            }
          />
        </div>
      </Body>
    </>
  );
}

const STATUS_TEXT: Record<CartStatus, string> = {
  open: 'Open',
  locked: 'Locked',
  submitted: 'Submitted',
  returned: 'Returned to the buyer',
  canceled: 'Canceled',
};

/** A quantity that is sent when it changes and the field loses focus or Enter is pressed. */
function QtyInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (qty: number) => void;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n !== value) onCommit(n);
    else setV(String(value));
  };
  return (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className="ml-auto h-7 w-20 text-right"
    />
  );
}

function AddLine({
  products,
  onAdd,
}: {
  products: { sku: string; name: string }[];
  onAdd: (sku: string, qty: number) => Promise<unknown>;
}) {
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState('1');
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const n = Number(qty);
        if (!sku.trim() || !Number.isInteger(n) || n < 1) return;
        const r = (await onAdd(sku.trim(), n)) as Result | null;
        if (r?.ok) {
          setSku('');
          setQty('1');
        }
      }}
    >
      <div className="grid gap-1 text-sm">
        <label htmlFor="add-sku" className="caption">
          SKU
        </label>
        <Input
          id="add-sku"
          list="cart-skus"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="WID-100"
          className="h-8 w-56"
          required
        />
        <datalist id="cart-skus">
          {products.map((p) => (
            <option key={p.sku} value={p.sku}>
              {p.name}
            </option>
          ))}
        </datalist>
      </div>
      <div className="grid gap-1 text-sm">
        <label htmlFor="add-qty" className="caption">
          Qty
        </label>
        <Input
          id="add-qty"
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="h-8 w-20"
          required
        />
      </div>
      <Button type="submit" size="sm" variant="outline">
        Add line
      </Button>
    </form>
  );
}

function Chat({
  title,
  messages,
  myId,
  onSay,
  onEdit,
  onDelete,
  onOlder,
}: {
  /** Says who reads it: an external cart's chat is shared with its buyer. */
  title: string;
  messages: CartChatMessage[];
  myId: string | null;
  onSay: (body: string) => Promise<{ ok: true; id: string } | { ok: false; error: string } | null>;
  onEdit: (id: string, body: string) => Promise<Result | null>;
  onDelete: (id: string) => Promise<Result | null>;
  onOlder: (before: string) => Promise<CartChatMessage[]>;
}) {
  const [draft, setDraft] = useState('');
  const [older, setOlder] = useState<CartChatMessage[]>([]);
  const [noMore, setNoMore] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const end = useRef<HTMLLIElement>(null);
  const shown = [...older.filter((o) => !messages.some((m) => m.id === o.id)), ...messages];
  const last = messages.at(-1)?.id;
  useEffect(() => {
    if (last) end.current?.scrollIntoView({ block: 'nearest' });
  }, [last]);

  return (
    <Section title={title} flush>
      <ol className="grid max-h-[28rem] gap-3 overflow-y-auto p-4 text-sm" aria-live="polite">
        {shown.length >= CART_CHAT_BROADCAST && !noMore ? (
          <li>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const page = await onOlder(shown[0]!.id);
                if (!page.length) setNoMore(true);
                setOlder((o) => [...page, ...o]);
              }}
            >
              Earlier messages
            </Button>
          </li>
        ) : null}
        {shown.length ? null : <li className="text-muted-foreground">No messages yet.</li>}
        {shown.map((m) => (
          <li key={m.id}>
            <div className="text-muted-foreground text-xs">
              <span className="font-medium text-foreground">{m.authorName}</span> ·{' '}
              <Ago ms={m.at} />
              {m.editedAt ? ' · edited' : ''}
            </div>
            {editing?.id === m.id ? (
              <form
                className="mt-1 grid gap-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if ((await onEdit(m.id, editing.body))?.ok) setEditing(null);
                }}
              >
                <Textarea
                  aria-label="Edit message"
                  value={editing.body}
                  maxLength={MAX_CHAT_BODY}
                  onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                />
                <div className="flex gap-1">
                  <Button type="submit" size="sm">
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
            )}
            {m.authorId === myId && editing?.id !== m.id ? (
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  className="text-muted-foreground hover:underline"
                  onClick={() => setEditing({ id: m.id, body: m.body })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:underline"
                  onClick={() => void onDelete(m.id)}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>
      <form
        className="grid gap-2 border-t p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if ((await onSay(draft))?.ok) setDraft('');
        }}
      >
        <Textarea
          aria-label="Message"
          value={draft}
          maxLength={MAX_CHAT_BODY}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Message everyone on this cart"
          rows={2}
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </Section>
  );
}

/** The cart's promotion codes, and a box to add one while it is open. */
function Promos({
  codes,
  editable,
  onAdd,
  onRemove,
}: {
  codes: string[];
  editable: boolean;
  onAdd: (code: string) => Promise<Result | null>;
  onRemove: (code: string) => Promise<Result | null>;
}) {
  const [code, setCode] = useState('');
  if (!codes.length && !editable) return null;
  return (
    <div className="mt-4 border-t pt-3">
      <h3 className="caption mb-1.5">Promotion codes</h3>
      {codes.length ? (
        <ul className="mb-2 flex flex-wrap gap-1.5 text-sm">
          {codes.map((c) => (
            <li
              key={c}
              className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono"
            >
              {c}
              {editable ? (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${c}`}
                  onClick={() => void onRemove(c)}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if ((await onAdd(code))?.ok) setCode('');
          }}
        >
          <Input
            aria-label="Promotion code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="WELCOME15"
            maxLength={32}
            autoCapitalize="characters"
            className="h-8 w-44 font-mono uppercase"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!code.trim()}>
            Apply
          </Button>
        </form>
      ) : null}
    </div>
  );
}

type ReturnPost = { url: string; fields: Record<string, string> };

/**
 * Posts a returned cart's fields to the buyer's system, as its punchout return expects: a form
 * submitted in this window as soon as it renders, with a button for when that doesn't happen.
 */
function ReturnForm({ post }: { post: ReturnPost }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.submit();
  }, []);
  return (
    <form
      ref={form}
      method="post"
      action={post.url}
      className="mx-auto max-w-[1400px] px-4 pt-6 sm:px-6"
    >
      {Object.entries(post.fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="rounded-md border px-3 py-2 text-sm">
        Sending the cart back to your system…{' '}
        <button type="submit" className="text-link hover:underline">
          Continue
        </button>
      </p>
    </form>
  );
}
