/**
 * The live cart, for staff on the Carts page (`routes/cart.tsx`) and for the buyer an external cart
 * was opened for (`routes/cart-buy.tsx`). `useAgent` connects to the cart's CartAgent over the
 * proxied socket, and every change anyone makes re-renders the lines, the quote, who is here and
 * the chat. Every change is an agent call; the agent checks who is calling and prices the cart.
 */

import {
  ATTACHMENT_TYPES,
  attachmentProblem,
  CART_CHAT_BROADCAST,
  type Cart,
  type CartAttachment,
  type CartChatMessage,
  type CartOp,
  type CartProduct,
  type CartProductPage,
  type CartState,
  type CartStatus,
  type CartTyping,
  type CheckoutQuote,
  cartReadyProblem,
  cartShippingOption,
  externalCartCap,
  isFinalCart,
  isQuoteCurrent,
  MAX_CHAT_BODY,
  MAX_LINE_QUANTITY,
  SHIP_TO_LIMITS,
  type ShipAddress,
} from '@orderloop/core';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@orderloop/ui/alert-dialog';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Textarea } from '@orderloop/ui/textarea';
import { useAgent } from 'agents/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/components/ago';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { type CartTicks, keepTicks, NO_TICKS, tick, tickAll, ticked } from '~/lib/cart-ticks';
import {
  NO_TYPISTS,
  nextTypingEnd,
  type Typists,
  typingAt,
  typingDue,
  typingLabel,
  typingSeen,
} from '~/lib/cart-typing';
import { money, until } from '~/lib/format';
import { useDateTime } from '~/lib/use-date-time';
import { useNow } from '~/lib/use-now';

type Result = { ok: true } | { ok: false; error: string };

export type CartViewProps = {
  snapshot: CartState;
  customerName: string | null;
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
  mode,
  meId,
  canOperate = false,
}: CartViewProps) {
  const guest = mode === 'guest';
  const [returning, setReturning] = useState<ReturnPost | null>(null);
  const [state, setState] = useState<CartState>(snapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticks, setTicks] = useState<CartTicks>(NO_TICKS);
  const [typists, setTypists] = useState<Typists>(NO_TYPISTS);
  const cart = state.cart!;
  const editableAs = (c: Cart) => (guest || canOperate) && c.status === 'open';

  const agent = useAgent<CartState>({
    agent: 'cart-agent',
    name: cart.id,
    // The buyer connects as the guest of this cart, whatever else this browser is signed in as.
    ...(guest ? { query: { as: 'guest' } } : {}),
    onStateUpdate: (s) => {
      setState(s);
      // Against each state as it arrives, so a line removed and added again (taking the same id)
      // is seen gone in between and comes back unticked.
      if (s.cart) setTicks((t) => keepTicks(t, s.cart!.lines, editableAs(s.cart!)));
    },
    // Who else is writing: sent beside the state, never in it.
    onMessage: (e) => {
      let m: Partial<CartTyping> | null = null;
      try {
        m = typeof e.data === 'string' ? JSON.parse(e.data) : null;
      } catch {}
      if (m?.type === 'cart_typing')
        setTypists((t) => typingSeen(t, m as CartTyping, meId, Date.now()));
    },
  });

  // Drop each notice when it ends: look again at the soonest end, not on a clock.
  useEffect(() => {
    const end = nextTypingEnd(typists);
    if (end === null) return;
    // At least `end`: a clock stepped back would otherwise drop nothing and never look again.
    const t = window.setTimeout(
      () => setTypists((x) => typingAt(x, Math.max(Date.now(), end))),
      Math.max(0, end - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [typists]);

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
  const editable = editableAs(cart);
  const priced = isQuoteCurrent(cart);
  const ready = cartReadyProblem(cart);
  const q = cart.quote;
  const currency = q?.currency ?? 'USD';
  const chosen = editable ? ticked(ticks, cart.lines) : [];

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
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy}>
                    Cancel cart
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel this cart?</AlertDialogTitle>
                    <AlertDialogDescription>It can’t be reopened.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep the cart</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void call('cancel')}>
                      Cancel cart
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
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
          {cart.external && !final ? <SessionEnds cart={cart} guest={guest} /> : null}
          {error ? (
            <p role="alert" className="rounded-md border border-bad/40 px-3 py-2 text-bad text-sm">
              {error}
            </p>
          ) : null}
          <Section title="Lines" flush>
            {editable && cart.lines.length ? (
              <BulkLines
                chosen={chosen.length}
                gone={ticks.gone}
                total={cart.lines.length}
                busy={busy}
                onAll={(on) => setTicks(tickAll(cart.lines, on))}
                onSetQty={async (qty) => {
                  // All or none, as the cart applies it: a ticked line gone since refuses the
                  // lot here, since its id may already name a line added after it.
                  if (ticks.gone) {
                    setError('A line you chose is gone.');
                    setTicks({ ...ticks, gone: 0 });
                    return null;
                  }
                  const r = await apply({
                    op: 'set_qtys',
                    lines: chosen.map((l) => ({ lineId: l.id, qty })),
                  });
                  if (r?.ok && qty === 0) setTicks(NO_TICKS);
                  return r;
                }}
                onRemove={async () => {
                  const r = await apply({ op: 'remove', lineIds: chosen.map((l) => l.id) });
                  if (r?.ok) setTicks(NO_TICKS);
                }}
              />
            ) : null}
            {cart.lines.length ? (
              <Table stack="cards" caption="Lines">
                <TableHead>
                  <Tr>
                    <Th>Item</Th>
                    <Th numeric className="w-28">
                      Qty
                    </Th>
                    <Th numeric>Unit</Th>
                    <Th numeric>Total</Th>
                    {editable ? (
                      <Th className="w-0">
                        <span className="sr-only">Actions</span>
                      </Th>
                    ) : null}
                  </Tr>
                </TableHead>
                <TableBody>
                  {cart.lines.map((l, i) => {
                    const issue = cart.issues.find((x) => x.path?.startsWith(`$.line_items[${i}]`));
                    return (
                      <Tr key={l.id} className="max-md:items-center">
                        <Td>
                          <div className="flex items-start gap-2.5">
                            {editable ? (
                              <label className="hit-area mt-0.5 inline-flex shrink-0">
                                <input
                                  type="checkbox"
                                  checked={ticks.picked.get(l.id) === l.sku}
                                  onChange={(e) =>
                                    setTicks(tick(ticks, l, e.currentTarget.checked))
                                  }
                                  className="relative z-[1] size-4 accent-primary"
                                />
                                <span className="sr-only">Select {l.sku}</span>
                              </label>
                            ) : null}
                            <div className="min-w-0">
                              <div className="font-medium">{l.title ?? l.sku}</div>
                              <div className="font-mono text-muted-foreground text-xs">{l.sku}</div>
                              {issue ? (
                                <div className="text-bad text-xs">{issue.content}</div>
                              ) : null}
                            </div>
                          </div>
                        </Td>
                        <Td numeric label="Qty">
                          {editable ? (
                            <QtyInput
                              value={l.qty}
                              label={`Quantity of ${l.sku}`}
                              onCommit={(qty) => apply({ op: 'set_qty', lineId: l.id, qty })}
                            />
                          ) : (
                            l.qty
                          )}
                        </Td>
                        <Td numeric label="Unit">
                          {l.unitPrice != null ? money(l.unitPrice, currency) : '—'}
                        </Td>
                        <Td numeric label="Total">
                          {l.unitPrice != null ? money(l.unitPrice * l.qty, currency) : '—'}
                        </Td>
                        {editable ? (
                          <Td className="max-md:ml-auto">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove ${l.sku}`}
                              onClick={() => apply({ op: 'remove', lineIds: [l.id] })}
                            >
                              Remove
                            </Button>
                          </Td>
                        ) : null}
                      </Tr>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <Empty>No lines yet.</Empty>
            )}
            {editable ? (
              <AddLines cartId={cart.id} onAdd={(sku, qty) => apply({ op: 'add', sku, qty })} />
            ) : null}
          </Section>

          {q?.ships || cart.shipTo ? (
            <ShipTo
              address={cart.shipTo ?? null}
              selected={cartShippingOption(cart)}
              quote={q}
              priced={priced}
              editable={editable}
              onAddress={(address) => apply({ op: 'set_ship_to', address })}
              onOption={(option) => apply({ op: 'set_shipping_option', option })}
            />
          ) : null}

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
          <Attachments
            cartId={cart.id}
            files={state.attachments ?? []}
            canAdd={(guest || canOperate) && !final}
            canRemove={(a) => !final && (a.by.id === meId || canOperate)}
            onRemove={(id) => call<Result>('detach', [id])}
          />
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
            typing={typingLabel(typists)}
            // Best effort, and only on an open socket: `useAgent` queues a call made while it is
            // down and sends it on reconnecting, by when the typing it announces is long over.
            onTyping={() => {
              if (agent.readyState === WebSocket.OPEN) void agent.call('typing').catch(() => {});
            }}
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

/** When the hint turns into a warning. */
const SESSION_WARN_MS = 10 * 60_000;

/**
 * When an external cart's session ends. One whose plugin set an idle window stays open while
 * anyone works on it (the agent moves its time on, and the new time arrives with the cart), so
 * the buyer is told how to keep it; near the end, or at its cap, it's a warning.
 */
function SessionEnds({ cart, guest }: { cart: NonNullable<CartState['cart']>; guest: boolean }) {
  const now = useNow(30_000);
  const formatTime = useDateTime();
  const x = cart.external!;
  const at = formatTime(x.expiresAt);
  const near = x.expiresAt - now < SESSION_WARN_MS;
  const slides = !!x.idleMs && x.expiresAt < externalCartCap(cart);
  const text = !guest
    ? `The buyer’s session ends ${at}${slides ? ' unless they keep working on the cart' : ''}.`
    : !near && slides
      ? `Your session stays open while you work on the cart. If you step away, it ends ${at}.`
      : near && slides
        ? `Your session ends ${at} (${until(x.expiresAt, now)}). Make a change to keep it open, or return the cart to your system.`
        : `Your session ends ${at}${near ? ` (${until(x.expiresAt, now)})` : ''}. Return the cart to your system before then.`;
  return (
    <p
      role={guest && near ? 'status' : undefined}
      className={cn(
        'text-muted-foreground text-sm',
        near && 'rounded-md border border-wait/40 px-3 py-2 font-medium text-wait',
      )}
      suppressHydrationWarning
    >
      {text}
    </p>
  );
}

const STATUS_TEXT: Record<CartStatus, string> = {
  open: 'Open',
  locked: 'Locked',
  submitted: 'Submitted',
  returned: 'Returned to the buyer',
  canceled: 'Canceled',
};

/**
 * What to do with the lines ticked below: select them all, set one quantity on every one (a
 * single change, priced once; 0 removes them) or remove them.
 */
function BulkLines({
  chosen,
  gone,
  total,
  busy,
  onAll,
  onSetQty,
  onRemove,
}: {
  chosen: number;
  /** Ticked lines someone else has removed since: Set quantity refuses until the person chooses again. */
  gone: number;
  total: number;
  busy: boolean;
  onAll: (on: boolean) => void;
  onSetQty: (qty: number) => Promise<Result | null>;
  onRemove: () => Promise<void>;
}) {
  const [qty, setQty] = useState('');
  const all = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (all.current) all.current.indeterminate = chosen > 0 && chosen < total;
  }, [chosen, total]);
  // The box sits above its label's touch target (`hit-area`), so a tap on either toggles it.
  const n = Number(qty);
  const valid = qty.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_LINE_QUANTITY;
  return (
    <fieldset
      aria-label="Selected lines"
      className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 text-sm"
    >
      <label className="hit-area inline-flex cursor-pointer items-center gap-2.5">
        <input
          ref={all}
          type="checkbox"
          checked={chosen > 0 && chosen === total}
          onChange={(e) => onAll(e.currentTarget.checked)}
          className="relative z-[1] size-4 accent-primary"
        />
        Select all
      </label>
      <span className="text-muted-foreground" aria-live="polite">
        {chosen ? `${chosen} of ${total} selected` : null}
        {gone ? (
          <span className="text-bad">
            {chosen ? ' · ' : null}
            {gone === 1 ? 'A line you chose is gone' : `${gone} lines you chose are gone`}
          </span>
        ) : null}
      </span>
      {chosen ? (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (valid && (await onSetQty(n))?.ok) setQty('');
            }}
          >
            <Input
              aria-label="Quantity for the selected lines"
              inputMode="numeric"
              enterKeyHint="done"
              placeholder="Qty"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              aria-invalid={(qty.trim() !== '' && !valid) || undefined}
              className="h-8 w-20 text-right"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={busy || !valid}
              className="hit-area"
            >
              {/* 0 takes the lines off: the button says so, where a thumb sees it (no tooltip). */}
              {valid && n === 0
                ? `Set 0, removing ${chosen === 1 ? 'the line' : `${chosen} lines`}`
                : 'Set quantity'}
            </Button>
          </form>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onRemove()}
            className="hit-area sm:ml-auto"
          >
            {removeLabel(chosen)}
          </Button>
        </>
      ) : null}
    </fieldset>
  );
}

const removeLabel = (n: number) => (n === 1 ? 'Remove line' : `Remove ${n} lines`);

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

/**
 * Finding products to add: a search of what the cart's quote can price (routes/cart-products.ts),
 * asked once the person pauses typing, each result with its quantity and Add. A price shown is
 * what the flow charges for one; the quote below says what the cart costs. A SKU the person
 * already knows can still be typed in and added.
 */
function AddLines({
  cartId,
  onAdd,
}: {
  cartId: string;
  onAdd: (sku: string, qty: number) => Promise<Result | null>;
}) {
  const [q, setQ] = useState('');
  // Results show from the first focus: an empty search lists the first products by SKU.
  const [browsing, setBrowsing] = useState(false);
  const [found, setFound] = useState<CartProductPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!browsing) return;
    const ctrl = new AbortController();
    const wait = setTimeout(
      async () => {
        setSearching(true);
        try {
          const res = await fetch(`/carts/${cartId}/products?q=${encodeURIComponent(q.trim())}`, {
            signal: ctrl.signal,
          });
          const body = (await res.json().catch(() => null)) as
            | (CartProductPage & { error?: string })
            | null;
          if (res.ok && body) {
            setFound(body);
            setProblem(null);
          } else {
            setFound(null);
            setProblem(body?.error ?? 'The search didn’t answer. Try again.');
          }
        } catch {
          if (!ctrl.signal.aborted) setProblem('The search didn’t answer. Try again.');
        } finally {
          if (!ctrl.signal.aborted) setSearching(false);
        }
      },
      q.trim() ? 250 : 0,
    );
    return () => {
      clearTimeout(wait);
      ctrl.abort();
    };
  }, [cartId, q, browsing]);

  const priced = found?.products.some((p) => p.unitPrice !== null);
  return (
    <div className="grid gap-2 border-t p-3">
      <search className="grid gap-1 text-sm">
        <label htmlFor={`find-${cartId}`} className="caption">
          Find a product
        </label>
        <Input
          id={`find-${cartId}`}
          type="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setBrowsing(true);
          }}
          onFocus={() => setBrowsing(true)}
          placeholder="Name or SKU"
          aria-controls={`found-${cartId}`}
          className="h-8 w-full sm:w-80"
        />
      </search>
      {browsing ? (
        <div id={`found-${cartId}`} className="grid gap-1">
          <p className="text-muted-foreground text-xs" aria-live="polite">
            {problem ? (
              <span role="alert" className="text-bad">
                {problem}
              </span>
            ) : searching && !found ? (
              'Searching…'
            ) : found && !found.products.length ? (
              q.trim() ? (
                `Nothing matches “${q.trim()}”.`
              ) : (
                'There are no products yet.'
              )
            ) : found?.more ? (
              `The first ${found.products.length} shown: add words to narrow it.`
            ) : null}
          </p>
          {found?.products.length ? (
            <ul
              aria-label="Products found"
              aria-busy={searching}
              className="max-h-80 divide-y overflow-y-auto overscroll-contain rounded-md border"
            >
              {found.products.map((p) => (
                <FoundProduct key={p.sku} product={p} currency={found.currency} onAdd={onAdd} />
              ))}
            </ul>
          ) : null}
          {priced ? (
            <p className="text-muted-foreground text-xs">
              Prices are for one, before promotions, shipping and tax.
            </p>
          ) : null}
        </div>
      ) : null}
      <AddBySku onAdd={onAdd} />
    </div>
  );
}

function FoundProduct({
  product: p,
  currency,
  onAdd,
}: {
  product: CartProduct;
  currency: string;
  onAdd: (sku: string, qty: number) => Promise<Result | null>;
}) {
  const [qty, setQty] = useState('1');
  const [added, setAdded] = useState(false);
  const n = Number(qty);
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_LINE_QUANTITY;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate font-medium">{p.name}</div>
        <div className="font-mono text-muted-foreground text-xs">{p.sku}</div>
      </div>
      {p.unitPrice !== null ? (
        <div className="text-right tabular-nums">
          {money(p.unitPrice, currency)}
          <span className="text-muted-foreground text-xs"> each</span>
        </div>
      ) : null}
      <form
        className="ml-auto flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          const r = await onAdd(p.sku, n);
          if (r?.ok) {
            setQty('1');
            setAdded(true);
          }
        }}
      >
        <Input
          aria-label={`Quantity of ${p.sku} to add`}
          inputMode="numeric"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            setAdded(false);
          }}
          aria-invalid={!valid || undefined}
          className="h-8 w-16 text-right"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!valid} className="hit-area">
          Add<span className="sr-only"> {p.sku}</span>
        </Button>
        <span className="w-10 text-muted-foreground text-xs" aria-live="polite">
          {added ? 'Added' : ''}
        </span>
      </form>
    </li>
  );
}

/** A SKU typed in, for one the person already knows. */
function AddBySku({ onAdd }: { onAdd: (sku: string, qty: number) => Promise<Result | null> }) {
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState('1');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const n = Number(qty);
        if (!sku.trim() || !Number.isInteger(n) || n < 1) return;
        const r = await onAdd(sku.trim(), n);
        if (r?.ok) {
          setSku('');
          setQty('1');
        }
      }}
    >
      <div className="grid gap-1 text-sm">
        <label htmlFor="add-sku" className="caption">
          Or add by SKU
        </label>
        <Input
          id="add-sku"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="WID-100"
          className="h-8 w-44"
          required
        />
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
      <Button type="submit" size="sm" variant="outline" className="hit-area">
        Add line
      </Button>
    </form>
  );
}

function Chat({
  title,
  messages,
  myId,
  typing,
  onTyping,
  onSay,
  onEdit,
  onDelete,
  onOlder,
}: {
  /** Says who reads it: an external cart's chat is shared with its buyer. */
  title: string;
  messages: CartChatMessage[];
  myId: string | null;
  /** Who else is writing (`typingLabel`), or ''. */
  typing: string;
  /** Tells the others this person is writing; the composer calls it at most every 2 seconds. */
  onTyping: () => void;
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
  const toldAt = useRef<number | null>(null);
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
          if ((await onSay(draft))?.ok) {
            setDraft('');
            // Sending ended this notice on the cart: the next message's writing says so at once.
            toldAt.current = null;
          }
        }}
      >
        {/* Always there and polite, so only a change in who is writing is read out. */}
        <p aria-live="polite" className="min-h-4 truncate text-muted-foreground text-xs">
          {typing}
        </p>
        <Textarea
          aria-label="Message"
          value={draft}
          maxLength={MAX_CHAT_BODY}
          onChange={(e) => {
            setDraft(e.target.value);
            const now = Date.now();
            if (e.target.value.trim() && typingDue(toldAt.current, now)) {
              toldAt.current = now;
              onTyping();
            }
          }}
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

const ADDRESS_FIELDS: {
  field: keyof ShipAddress;
  label: string;
  autoComplete: string;
  wide?: boolean;
}[] = [
  { field: 'name', label: 'Name', autoComplete: 'shipping name', wide: true },
  { field: 'line1', label: 'Street address', autoComplete: 'shipping address-line1', wide: true },
  { field: 'line2', label: 'Address line 2', autoComplete: 'shipping address-line2', wide: true },
  { field: 'city', label: 'City', autoComplete: 'shipping address-level2' },
  { field: 'region', label: 'State or region', autoComplete: 'shipping address-level1' },
  { field: 'postalCode', label: 'Postcode', autoComplete: 'shipping postal-code' },
  { field: 'country', label: 'Country', autoComplete: 'shipping country' },
];

const blankAddress = (a: Partial<ShipAddress> | null) =>
  Object.fromEntries(ADDRESS_FIELDS.map(({ field }) => [field, a?.[field] ?? ''])) as Record<
    keyof ShipAddress,
    string
  >;

/**
 * Where the cart ships and how: the address it is quoted for, and the options the flow offers for
 * it, each with its price. Saving the address or picking an option prices the cart again.
 */
function ShipTo({
  address,
  selected,
  quote,
  priced,
  editable,
  onAddress,
  onOption,
}: {
  address: Partial<ShipAddress> | null;
  /** What the quote charged once it is current (`cartShippingOption`), not only what was chosen. */
  selected: string | null;
  quote: CheckoutQuote | null;
  /** Whether `quote` prices the cart as it is now; its options can't be picked until it does. */
  priced: boolean;
  editable: boolean;
  onAddress: (a: Partial<ShipAddress> | null) => Promise<Result | null>;
  onOption: (id: string) => Promise<Result | null>;
}) {
  const [draft, setDraft] = useState(() => blankAddress(address));
  const saved = JSON.stringify(blankAddress(address));
  // Someone else on the cart changed it: show theirs.
  useEffect(() => setDraft(JSON.parse(saved)), [saved]);
  const changed = JSON.stringify(draft) !== saved;
  const currency = quote?.currency ?? 'USD';
  return (
    <Section title="Ship to">
      {editable ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const filled = Object.fromEntries(
              Object.entries(draft).filter(([, v]) => v.trim()),
            ) as Partial<ShipAddress>;
            await onAddress(Object.keys(filled).length ? filled : null);
          }}
        >
          {ADDRESS_FIELDS.map(({ field, label, autoComplete, wide }) => (
            <div key={field} className={`grid gap-1 text-sm ${wide ? 'sm:col-span-2' : ''}`}>
              <label htmlFor={`ship-${field}`} className="caption">
                {label}
              </label>
              <Input
                id={`ship-${field}`}
                autoComplete={autoComplete}
                value={draft[field]}
                maxLength={SHIP_TO_LIMITS[field]}
                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                className="h-8"
              />
            </div>
          ))}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm" variant="outline" disabled={!changed}>
              Save address
            </Button>
            {address ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void onAddress(null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      ) : address ? (
        <address className="text-sm not-italic">
          {[address.name, address.line1, address.line2].filter(Boolean).map((l) => (
            <div key={l}>{l}</div>
          ))}
          <div>{[address.city, address.region, address.postalCode].filter(Boolean).join(' ')}</div>
          {address.country ? <div>{address.country}</div> : null}
        </address>
      ) : (
        <p className="text-muted-foreground text-sm">No address yet.</p>
      )}

      {quote?.shippingOptions.length ? (
        <fieldset className="mt-4 border-t pt-3" disabled={!editable || !priced}>
          <legend className="caption mb-1.5">Shipping option</legend>
          <div className="grid gap-2">
            {quote.shippingOptions.map((o) => (
              <label
                key={o.id}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-secondary has-[:disabled]:cursor-default"
              >
                <input
                  type="radio"
                  name="shipping-option"
                  value={o.id}
                  checked={selected === o.id}
                  onChange={() => void onOption(o.id)}
                  className="mt-0.5"
                />
                <span className="grow">
                  <span className="font-medium">{o.title}</span>
                  <span className="block text-muted-foreground text-xs">
                    {o.carrier} ·{' '}
                    {o.minDays === o.maxDays ? o.minDays : `${o.minDays}–${o.maxDays}`}{' '}
                    {o.maxDays === 1 ? 'day' : 'days'}
                  </span>
                </span>
                <span className="tabular-nums">
                  {o.free || o.amount === 0 ? 'Free' : money(o.amount, currency)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
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

const size = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The cart's files: anyone on it can download them; adding one uploads it through the web app. */
function Attachments({
  cartId,
  files,
  canAdd,
  canRemove,
  onRemove,
}: {
  cartId: string;
  files: CartAttachment[];
  canAdd: boolean;
  canRemove: (a: CartAttachment) => boolean;
  onRemove: (id: string) => Promise<Result | null>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  if (!files.length && !canAdd) return null;
  async function upload(file: File) {
    setError(null);
    const problem = attachmentProblem(file, files.length);
    if (problem) return setError(problem);
    setUploading(true);
    try {
      const body = new FormData();
      body.set('file', file);
      const res = await fetch(`/carts/${cartId}/attachments`, { method: 'POST', body });
      if (!res.ok)
        setError(
          ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
            'The file didn’t upload.',
        );
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <Section title="Files" flush>
      {files.length ? (
        <ul className="divide-y text-sm">
          {files.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-2 px-4 py-2">
              <div className="min-w-0">
                <a
                  href={`/carts/${cartId}/attachments/${a.id}`}
                  className="block truncate text-link hover:underline"
                  download={a.name}
                >
                  {a.name}
                </a>
                <div className="text-muted-foreground text-xs">
                  {ATTACHMENT_TYPES[a.type] ?? a.type} · {size(a.size)} · {a.by.name} ·{' '}
                  <Ago ms={a.at} />
                </div>
              </div>
              {canRemove(a) ? (
                <button
                  type="button"
                  className="text-muted-foreground text-xs hover:underline"
                  onClick={() => void onRemove(a.id)}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-muted-foreground text-sm">No files yet.</p>
      )}
      {canAdd ? (
        <div className="grid gap-1 border-t p-3">
          <label htmlFor={`attach-${cartId}`} className="caption">
            Add a file (PDF, image, CSV, text, Excel or Word; up to 10 MB)
          </label>
          <input
            ref={input}
            id={`attach-${cartId}`}
            type="file"
            accept={Object.keys(ATTACHMENT_TYPES).join(',')}
            disabled={uploading}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void upload(f);
            }}
            className="text-sm"
          />
          {uploading ? <p className="text-muted-foreground text-xs">Uploading…</p> : null}
          {error ? (
            <p role="alert" className="text-bad text-xs">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
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
      className="mx-auto max-w-page px-4 pt-6 sm:px-6"
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
