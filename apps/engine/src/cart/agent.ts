/**
 * CartAgent: one Agents SDK Durable Object per cart (`packages/core/src/cart.ts`). It holds the
 * cart, syncs it to everyone who has it open with who else is there and the newest chat, applies
 * ops one at a time, prices the cart with its flow's pricing nodes (`quoteCheckout`, as a checkout
 * is priced) and submits it as an order of that flow. Chat history lives in this object's SQL.
 *
 * Who is calling: the web app proxies the Carts page's socket here with the signed principal, and
 * `cartGate` (./gate.ts) has already refused a request without a live one before the socket
 * opens, so no state reaches anyone else. Each call re-reads the person (`livePrincipal`) so a
 * role change or signing out applies to a page already open. RPC methods (from EngineApi, which
 * the web app reaches only from its own authorized routes) take the actor as an argument.
 */

import {
  applyCartOp,
  atLeast,
  BASE_CURRENCY,
  CART_CHAT_BROADCAST,
  type Cart,
  type CartActor,
  type CartChatMessage,
  type CartMember,
  type CartOp,
  type CartState,
  type CheckoutSession,
  canChangeMessage,
  canReadCart,
  cartReadyProblem,
  chatBody,
  EMPTY_CART_STATE,
  finishCart,
  isFinalCart,
  newId,
  type ProxiedPrincipal,
} from '@orderloop/core';
import { carts, createDb } from '@orderloop/db';
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from 'agents';
import { loadFlowVersion } from '../flows';
import { startOrderOnce } from '../orders';
import { forwardedPrincipal, livePrincipal, SESSION_ENDED } from '../principal';
import { quoteCheckout } from '../ucp/quote';

/** Per-connection state: who opened the socket, and how they show in the members list. */
type ConnectionState = { principal: ProxiedPrincipal | null; member: CartMember | null };

/** Messages a person may send in a burst, and how long the burst lasts. */
const CHAT_BURST = 10;
const CHAT_WINDOW_MS = 10_000;

type ChatRow = {
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  at: number;
  edited_at: number | null;
};

const fromRow = (r: ChatRow): CartChatMessage => ({
  id: r.id,
  authorId: r.author_id,
  authorName: r.author_name,
  body: r.body,
  at: r.at,
  editedAt: r.edited_at,
});

export class CartAgent extends Agent<Env, CartState> {
  override initialState: CartState = EMPTY_CART_STATE;

  /** Browsers read the cart and call methods; they never write state. */
  override validateStateChange(_next: CartState, source: Connection | 'server') {
    if (source !== 'server') throw new Error('Cart state is read-only');
  }

  private tablesReady = false;

  private tables() {
    if (this.tablesReady) return;
    this
      .sql`CREATE TABLE IF NOT EXISTS cart_chat (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, edited_at INTEGER)`;
    this.tablesReady = true;
  }

  private db() {
    return createDb(this.env.DB);
  }

  private cart(): Cart {
    const c = this.state.cart;
    if (!c) throw new Error('No such cart.');
    return c;
  }

  /** Writes the cart and keeps the Carts page's D1 row in step when its title or status changed. */
  private async save(next: Cart) {
    const before = this.state.cart;
    this.setState({ ...this.state, cart: next });
    if (!before || before.title !== next.title || before.status !== next.status)
      await this.index(next);
  }

  private async index(c: Cart) {
    const row = {
      title: c.title,
      status: c.status,
      customerId: c.customerId,
      orderId: c.orderId,
      updatedAt: c.updatedAt,
    };
    await this.db()
      .insert(carts)
      .values({
        id: c.id,
        flowId: c.flowId,
        pluginId: c.external?.pluginId ?? null,
        sessionRef: c.external?.sessionRef ?? null,
        expiresAt: c.external?.expiresAt ?? null,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        ...row,
      })
      .onConflictDoUpdate({ target: carts.id, set: row });
  }

  /** Set while `submitAs` starts the order, so nothing else ends the cart meanwhile. */
  private submitting = false;

  // ── RPC (EngineApi) ──

  /** Makes this object the cart `init` describes; a second call returns the cart as it is. */
  async create(init: Cart): Promise<Cart> {
    if (this.state.cart) return this.state.cart;
    await this.save(init);
    if (init.lines.length) await this.reprice();
    return this.cart();
  }

  async snapshot(): Promise<CartState | null> {
    return this.state.cart ? this.state : null;
  }

  /** Applies `op` as `actor`; the socket's `apply` is this with the signed-in caller. */
  async applyAs(
    actor: CartActor,
    op: CartOp,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = applyCartOp(this.cart(), op, actor, Date.now());
    if (!r.ok) return r;
    await this.save(r.cart);
    if (r.reprice) await this.reprice();
    return { ok: true };
  }

  /**
   * Starts the cart's order, once: the cart is held (`locked`, its version kept so the quote stays
   * current) while the order starts, so no op lands between the check and the start, and is
   * `submitted` once the order exists. The idempotency key is the cart's, so a retry after a
   * failure part-way finds the same order.
   */
  async submitAs(
    actor: CartActor,
  ): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
    if (actor.kind !== 'staff' || !atLeast(actor.role, 'operator'))
      return { ok: false, error: 'This needs the Operator role.' };
    if (this.submitting) return { ok: false, error: 'The cart is being submitted.' };
    const c = this.cart();
    if (c.external) return { ok: false, error: 'An external cart goes back to its buyer.' };
    const problem = cartReadyProblem(c);
    if (problem) return { ok: false, error: problem };
    const q = c.quote!;
    const held = c;
    // Held before the first await, so no op or cancel lands between the check and the start.
    this.submitting = true;
    this.setState({ ...this.state, cart: { ...c, status: 'locked' } });
    try {
      const flow = await loadFlowVersion(this.env, c.flowId);
      if (!flow) throw new Error('The cart’s flow is gone.');
      const started = await startOrderOnce(this.env, {
        flowId: flow.id,
        idempotencyKey: `cart:${c.id}`,
        startedBy: actor.id,
        input: {
          model: flow.model,
          channel: 'manual',
          externalId: c.id,
          title: c.title,
          currency: q.currency,
          ...(c.customerId ? { customerId: c.customerId } : {}),
          lines: q.lines.map((l) => ({ sku: l.sku, name: l.title, qty: l.qty })),
          meta: {
            cart: { id: c.id },
            ...(c.promoCodes.length ? { promoCodes: c.promoCodes } : {}),
          },
        },
      });
      if ('mismatch' in started) throw new Error('This cart already started a different order.');
      await this.save(
        finishCart(held, { status: 'submitted', orderId: started.orderId }, Date.now()),
      );
      return { ok: true, orderId: started.orderId };
    } catch (err) {
      this.setState({ ...this.state, cart: held });
      console.error(`submitting cart ${c.id}`, err);
      return { ok: false, error: err instanceof Error ? err.message : 'The order didn’t start.' };
    } finally {
      this.submitting = false;
    }
  }

  async cancelAs(actor: CartActor): Promise<{ ok: true } | { ok: false; error: string }> {
    if (actor.kind !== 'staff' || !atLeast(actor.role, 'operator'))
      return { ok: false, error: 'This needs the Operator role.' };
    if (this.submitting) return { ok: false, error: 'The cart is being submitted.' };
    const c = this.cart();
    if (isFinalCart(c)) return { ok: false, error: `The cart is ${c.status}.` };
    await this.save(finishCart(c, { status: 'canceled' }, Date.now()));
    return { ok: true };
  }

  /**
   * Prices the cart as it is now with its flow's pricing nodes. A quote finished after the cart
   * changed again is dropped: the change that made it stale priced the cart anew.
   */
  private async reprice() {
    const c = this.cart();
    const flow = await loadFlowVersion(this.env, c.flowId);
    if (!flow) {
      await this.save({
        ...c,
        quote: null,
        quotedVersion: c.version,
        issues: [{ kind: 'error', code: 'invalid', content: 'The cart’s flow is gone.' }],
      });
      return;
    }
    const session: CheckoutSession = {
      id: c.id,
      ownerId: c.createdBy,
      status: 'incomplete',
      currency: BASE_CURRENCY,
      lines: c.lines,
      buyer: {},
      fulfillment: 'ship',
      shipTo: null,
      shippingOption: null,
      quote: null,
      issues: [],
      orderId: null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      expiresAt: c.external?.expiresAt ?? Number.MAX_SAFE_INTEGER,
      version: c.version,
    };
    const { quote, issues } = c.lines.length
      ? await quoteCheckout(this.env, flow, session, {
          channel: 'manual',
          ...(c.customerId ? { customerId: c.customerId } : {}),
          meta: c.promoCodes.length ? { promoCodes: c.promoCodes } : {},
        })
      : { quote: null, issues: [] };
    const now = this.state.cart;
    if (!now || now.version !== c.version) return;
    const lines = quote
      ? now.lines.map((l) => {
          const priced = quote.lines.find((p) => p.id === l.id);
          return priced ? { ...l, title: priced.title, unitPrice: priced.unitPrice } : l;
        })
      : now.lines;
    this.setState({
      ...this.state,
      cart: { ...now, lines, quote, quotedVersion: now.version, issues },
    });
  }

  // ── The cart's socket ──

  override async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    const principal = await forwardedPrincipal(this.env, ctx.request);
    const member: CartMember | null = principal
      ? { id: principal.id, name: principal.name, kind: 'staff' }
      : null;
    connection.setState({ principal, member });
    this.syncMembers();
    await this.keepChecking();
  }

  override async onClose(connection: Connection) {
    this.syncMembers(connection.id);
  }

  /** How often open sockets are checked against live sign-ins. */
  private static RECHECK_S = 30;

  /**
   * Closes every socket whose person can no longer read the cart (signed out, disabled, a revoked
   * token, a role below viewer): broadcasts reach a socket without it calling anything, so a call's
   * own check isn't enough. Runs on a schedule while anyone has the cart open.
   */
  async recheckConnections() {
    let open = 0;
    for (const c of this.getConnections<ConnectionState>()) {
      const stored = c.state?.principal ?? null;
      const p = stored ? await livePrincipal(this.env, stored) : null;
      if (!p || !atLeast(p.role, 'viewer')) c.close(4401, 'Session ended');
      else open++;
    }
    this.syncMembers();
    if (open) await this.schedule(CartAgent.RECHECK_S, 'recheckConnections');
  }

  private async keepChecking() {
    if (!this.getSchedules().some((s) => s.callback === 'recheckConnections'))
      await this.schedule(CartAgent.RECHECK_S, 'recheckConnections');
  }

  /** Everyone with the cart open, once each, from the live connections. */
  private syncMembers(leaving?: string) {
    if (!this.state.cart) return;
    const seen = new Map<string, CartMember>();
    for (const c of this.getConnections<ConnectionState>()) {
      const m = c.state?.member;
      if (c.id !== leaving && m && !seen.has(m.id)) seen.set(m.id, m);
    }
    const members = [...seen.values()];
    const key = (ms: CartMember[]) => ms.map((m) => m.id).join(',');
    if (key(members) !== key(this.state.members)) this.setState({ ...this.state, members });
  }

  /** The socket's caller as they are now, or throws (and closes a socket whose sign-in ended). */
  private async caller(): Promise<CartActor> {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error('Call this over the cart’s socket.');
    const stored = (connection.state as ConnectionState | null)?.principal ?? null;
    const p = stored ? await livePrincipal(this.env, stored) : null;
    if (!p) {
      setTimeout(() => connection.close(4401, 'Session ended'), 100);
      throw new Error(SESSION_ENDED);
    }
    const actor: CartActor = { kind: 'staff', id: p.id, name: p.name, role: p.role };
    if (!canReadCart(this.cart(), actor)) throw new Error('This needs the Viewer role.');
    return actor;
  }

  @callable()
  async whoami() {
    const a = await this.caller();
    return { id: a.id, name: a.name, kind: a.kind, role: a.kind === 'staff' ? a.role : null };
  }

  @callable()
  async apply(op: CartOp) {
    return this.applyAs(await this.caller(), op);
  }

  @callable()
  async submit() {
    return this.submitAs(await this.caller());
  }

  @callable()
  async cancel() {
    return this.cancelAs(await this.caller());
  }

  private sent = new Map<string, number[]>();

  /** Posts a chat message as the caller. */
  @callable()
  async say(raw: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const a = await this.caller();
    const body = typeof raw === 'string' ? chatBody(raw) : null;
    if (!body) return { ok: false, error: 'A message is 1 to 4,000 characters.' };
    const now = Date.now();
    const recent = (this.sent.get(a.id) ?? []).filter((t) => now - t < CHAT_WINDOW_MS);
    if (recent.length >= CHAT_BURST) return { ok: false, error: 'Slow down a moment.' };
    this.sent.set(a.id, [...recent, now]);
    this.tables();
    const m: CartChatMessage = {
      id: newId('msg'),
      authorId: a.id,
      authorName: a.name,
      body,
      at: now,
      editedAt: null,
    };
    this
      .sql`INSERT INTO cart_chat (id, author_id, author_name, body, at) VALUES (${m.id}, ${m.authorId}, ${m.authorName}, ${m.body}, ${m.at})`;
    this.setState({ ...this.state, chat: [...this.state.chat, m].slice(-CART_CHAT_BROADCAST) });
    return { ok: true, id: m.id };
  }

  private message(id: string): CartChatMessage | null {
    this.tables();
    const r = this.sql<ChatRow>`SELECT * FROM cart_chat WHERE id = ${id}`[0];
    return r ? fromRow(r) : null;
  }

  /** Changes the caller's own message. */
  @callable()
  async edit(id: string, raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const a = await this.caller();
    const m = this.message(id);
    if (!m) return { ok: false, error: 'That message is gone.' };
    if (!canChangeMessage(m, a)) return { ok: false, error: 'Only its author can change it.' };
    const body = typeof raw === 'string' ? chatBody(raw) : null;
    if (!body) return { ok: false, error: 'A message is 1 to 4,000 characters.' };
    const editedAt = Date.now();
    this.sql`UPDATE cart_chat SET body = ${body}, edited_at = ${editedAt} WHERE id = ${id}`;
    this.setState({
      ...this.state,
      chat: this.state.chat.map((x) => (x.id === id ? { ...x, body, editedAt } : x)),
    });
    return { ok: true };
  }

  /** Deletes the caller's own message. */
  @callable()
  async unsay(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const a = await this.caller();
    const m = this.message(id);
    if (!m) return { ok: false, error: 'That message is gone.' };
    if (!canChangeMessage(m, a)) return { ok: false, error: 'Only its author can delete it.' };
    this.sql`DELETE FROM cart_chat WHERE id = ${id}`;
    // Refill the tail from SQL, so deleting one doesn't shorten what the page shows.
    const tail = this
      .sql<ChatRow>`SELECT * FROM cart_chat ORDER BY seq DESC LIMIT ${CART_CHAT_BROADCAST}`;
    this.setState({ ...this.state, chat: tail.map(fromRow).reverse() });
    return { ok: true };
  }

  /** Up to 50 messages before the one with id `before` (or the newest), oldest first. */
  @callable()
  async history(before?: string): Promise<CartChatMessage[]> {
    await this.caller();
    this.tables();
    const rows = before
      ? this
          .sql<ChatRow>`SELECT * FROM cart_chat WHERE seq < (SELECT seq FROM cart_chat WHERE id = ${before}) ORDER BY seq DESC LIMIT ${CART_CHAT_BROADCAST}`
      : this.sql<ChatRow>`SELECT * FROM cart_chat ORDER BY seq DESC LIMIT ${CART_CHAT_BROADCAST}`;
    return rows.map(fromRow).reverse();
  }
}
