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
  attachmentName,
  attachmentProblem,
  CART_CHANGED_SINCE_CONFIRM,
  CART_CHAT_BROADCAST,
  CART_EVENT_RETRIES,
  CART_START_TTL_MS,
  CART_TYPING_EVERY_MS,
  CART_TYPING_MS,
  type Cart,
  type CartActor,
  type CartAttachment,
  type CartChatMessage,
  type CartEvent,
  type CartGuest,
  type CartMember,
  type CartOp,
  type CartState,
  type CartSummary,
  type CartTyping,
  canChangeMessage,
  canEditCart,
  canReadCart,
  canRemoveAttachment,
  cartAttachmentKey,
  cartAttachmentPrefix,
  cartEventRetryDelaySec,
  cartReadyProblem,
  cartSummary,
  chatBody,
  checkCartReturn,
  EMPTY_CART_STATE,
  ERASED,
  eraseText,
  erasureTerms,
  extendedCartExpiry,
  externalCartEnd,
  finishCart,
  guestCartOpen,
  isCartExpired,
  isFinalCart,
  newId,
  type PluginCart,
  type ProxiedPrincipal,
  quoteNodes,
  storedCart,
} from '@orderloop/core';
import { carts, createDb, webhookDeliveries } from '@orderloop/db';
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from 'agents';
import { and, eq } from 'drizzle-orm';
import { loadFlowVersion } from '../flows';
import { startOrderOnce } from '../orders';
import { emitCart } from '../outbox';
import { pluginStub } from '../plugin-host';
import { callPlugin, mayUse } from '../plugins';
import { forwardedGuest, forwardedPrincipal, livePrincipal, SESSION_ENDED } from '../principal';
import { quoteCheckout } from '../ucp/quote';
import { cartDraftExtra, cartSession } from './session';

/**
 * Per-connection state: who opened the socket (a staff principal, or the buyer an external cart was
 * opened for), and how they show in the members list.
 */
type ConnectionState = {
  principal: ProxiedPrincipal | null;
  guest?: CartGuest | null;
  member: CartMember | null;
};

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** Messages a person may send in a burst, and how long the burst lasts. */
const CHAT_BURST = 10;
const CHAT_WINDOW_MS = 10_000;
/** Changes a guest may make in a burst. */
const EDIT_BURST = 20;
const EDIT_WINDOW_MS = 10_000;
/**
 * Promotion codes tried on one cart in an hour, by anyone: enough for a buyer's typos, too few to
 * guess at codes (each answer says whether a code works here).
 */
export const PROMO_TRIES = 10;
const PROMO_WINDOW_MS = 60 * 60_000;

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
    // One-time start links for an external cart's buyer (only the hash is kept), and its return.
    this
      .sql`CREATE TABLE IF NOT EXISTS cart_starts (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER)`;
    this
      .sql`CREATE TABLE IF NOT EXISTS cart_return (id INTEGER PRIMARY KEY, url TEXT NOT NULL, fields TEXT NOT NULL)`;
    this.tablesReady = true;
  }

  private db() {
    return createDb(this.env.DB);
  }

  private cart(): Cart {
    const c = this.state.cart;
    if (!c) throw new Error('No such cart.');
    return storedCart(c);
  }

  /**
   * Writes the cart and keeps the Carts page's D1 row in step when its title or status changed.
   * `event` is queued with the change, before the D1 write, so a failed write can't lose it.
   */
  private async save(next: Cart, event?: CartEvent) {
    const before = this.state.cart;
    this.setState({ ...this.state, cart: next });
    if (event) await this.announce(event);
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
      // What the gate admits a buyer by: moved on while they work (`keepOpen`).
      expiresAt: c.external?.expiresAt ?? null,
      // Who an external cart is for, so a data subject request finds it: '' once erased (indexed,
      // no buyer), null only on a staff cart or an external one not indexed since 0050.
      buyerId: c.external
        ? c.external.buyer.id === ERASED
          ? ''
          : c.external.buyer.id.toLowerCase()
        : null,
    };
    await this.db()
      .insert(carts)
      .values({
        id: c.id,
        flowId: c.flowId,
        pluginId: c.external?.pluginId ?? null,
        sessionRef: c.external?.sessionRef ?? null,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        ...row,
      })
      .onConflictDoUpdate({ target: carts.id, set: row });
  }

  /** Bumped by every erasure: an event queued before one carries what it erased, and is dropped. */
  private erasures(): number {
    return this.ctx.storage.kv.get<number>('cart_erasures') ?? 0;
  }

  /**
   * Announces `event` with the cart as it is now (`cartSummary`), from this object's schedule so the
   * delivery outlives the call that changed the cart. A schedule that can't be written throws, so
   * the call fails rather than ending the cart unannounced.
   */
  private async announce(event: CartEvent) {
    await this.schedule(0, 'emitWebhook', {
      event,
      cart: cartSummary(this.cart()),
      attempt: 0,
      erasure: this.erasures(),
    });
  }

  /**
   * Delivers a cart's event (`emitCart`), retried on this object's schedule for about a day
   * (`cartEventRetryDelaySec`), then left `failed` in its delivery rows, where the subscription's
   * deliveries and the Plugins page show it. Deliveries are keyed by the cart and the event, so a
   * retry sends only what hasn't arrived. One queued before an erasure is dropped, and one that was
   * on its way while an erasure ran takes back what it wrote.
   */
  async emitWebhook(p: { event: CartEvent; cart: CartSummary; attempt: number; erasure?: number }) {
    const erasure = p.erasure ?? 0;
    if (erasure !== this.erasures()) return;
    let pending = 1;
    try {
      ({ pending } = await emitCart(this.env, p.cart, p.event));
    } catch (err) {
      console.warn('webhook emit', p.event, err);
    }
    if (erasure !== this.erasures()) {
      await this.db()
        .delete(webhookDeliveries)
        .where(and(eq(webhookDeliveries.orderId, p.cart.id), eq(webhookDeliveries.event, p.event)));
      return;
    }
    if (!pending) return;
    if (p.attempt < CART_EVENT_RETRIES)
      await this.schedule(cartEventRetryDelaySec(p.attempt), 'emitWebhook', {
        ...p,
        attempt: p.attempt + 1,
      });
    else console.warn('webhook delivery gave up', p.event, p.cart.id);
  }

  /**
   * Forgets the cart's events after an erasure: they carried its title as it was. Undelivered ones
   * aren't retried, and every delivery row goes, sent or not, as an erased order's do.
   */
  private async dropEvents() {
    this.ctx.storage.kv.put('cart_erasures', this.erasures() + 1);
    for (const s of this.getSchedules())
      if (s.callback === 'emitWebhook') await this.cancelSchedule(s.id);
    const id = this.state.cart?.id;
    if (id) await this.db().delete(webhookDeliveries).where(eq(webhookDeliveries.orderId, id));
  }

  /**
   * A customer's erasure reaching a staff cart (one for their account, or one that became their
   * order): `terms` leave its title, and its events, which carried the title, go.
   */
  async eraseFromEvents(terms: string[]): Promise<boolean> {
    const c = this.state.cart;
    if (!c) return false;
    await this.dropEvents();
    const title = eraseText(c.title, erasureTerms(terms));
    if (title !== c.title) {
      this.setState({ ...this.state, cart: { ...this.cart(), title } });
      await this.index(this.cart());
    }
    return true;
  }

  /** Deletes every file stored for this cart (its `cartAttachmentPrefix`). Returns how many. */
  private async deleteFiles(): Promise<number> {
    const c = this.state.cart;
    if (!c) return 0;
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.DOCS.list({ prefix: cartAttachmentPrefix(c.id), cursor });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await this.env.DOCS.delete(keys);
      deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return deleted;
  }

  /**
   * Retention: an ended cart keeps its lines, quote and order, and loses what people said and
   * sent on it: its chat, files, return form, start links, its ship-to (the order keeps its own)
   * and who its buyer was. Safe to repeat.
   */
  async purge(): Promise<{ purged: boolean; messages: number; files: number }> {
    const c = this.state.cart;
    if (!c || !isFinalCart(c)) return { purged: false, messages: 0, files: 0 };
    this.tables();
    const messages = this.sql<{ n: number }>`SELECT count(*) AS n FROM cart_chat`[0]?.n ?? 0;
    this.sql`DELETE FROM cart_chat`;
    this.sql`DELETE FROM cart_return`;
    this.sql`DELETE FROM cart_starts`;
    const files = await this.deleteFiles();
    const kept = { ...storedCart(c), shipTo: null };
    this.setState({
      ...this.state,
      cart: kept.external
        ? { ...kept, external: { ...kept.external, buyer: { id: ERASED, name: ERASED } } }
        : kept,
      chat: [],
      attachments: [],
    });
    await this.index(this.cart());
    await this.db().update(carts).set({ purgedAt: Date.now() }).where(eq(carts.id, c.id));
    return { purged: true, messages, files };
  }

  /**
   * A data subject request for the buyer an external cart was opened for: an open cart is
   * canceled; their messages and files are removed; `terms` (their email and names) are erased
   * from everyone else's messages and the title; and the cart no longer names them or holds the
   * address they shipped to.
   */
  async eraseSubject(terms: string[]): Promise<{ messages: number; files: number }> {
    const c = this.state.cart;
    if (!c?.external) return { messages: 0, files: 0 };
    const open = !isFinalCart(c);
    // Closed at once, so no one changes it meanwhile; indexed and announced once it's erased.
    if (open)
      this.setState({ ...this.state, cart: finishCart(c, { status: 'canceled' }, Date.now()) });
    const guestId = `guest:${c.external.buyer.id}`;
    const all = erasureTerms([...terms, c.external.buyer.id, c.external.buyer.name]);
    this.tables();
    const theirs =
      this.sql<{ n: number }>`SELECT count(*) AS n FROM cart_chat WHERE author_id = ${guestId}`[0]
        ?.n ?? 0;
    this.sql`DELETE FROM cart_chat WHERE author_id = ${guestId}`;
    for (const r of this.sql<{
      id: string;
      body: string;
      author_name: string;
    }>`SELECT id, body, author_name FROM cart_chat`) {
      const body = eraseText(r.body, all);
      if (body !== r.body) this.sql`UPDATE cart_chat SET body = ${body} WHERE id = ${r.id}`;
    }
    this.sql`DELETE FROM cart_return`;
    this.sql`DELETE FROM cart_starts`;
    const files = (this.state.attachments ?? []).filter((a) => a.by.id === guestId);
    for (const a of files) await this.env.DOCS.delete(a.key);
    const tail = this
      .sql<ChatRow>`SELECT * FROM cart_chat ORDER BY seq DESC LIMIT ${CART_CHAT_BROADCAST}`;
    const now = this.cart();
    this.setState({
      ...this.state,
      cart: {
        ...now,
        title: eraseText(now.title, all),
        shipTo: null,
        external: { ...now.external!, buyer: { id: ERASED, name: ERASED } },
      },
      chat: tail.map(fromRow).reverse(),
      attachments: (this.state.attachments ?? []).filter((a) => a.by.id !== guestId),
      members: this.state.members.filter((m) => m.id !== guestId),
    });
    for (const conn of this.getConnections<ConnectionState>())
      if (conn.state?.guest) conn.close(4410, 'Cart closed');
    await this.dropEvents();
    // The cancel is announced with the title erased.
    if (open) await this.announce('cart.canceled');
    await this.index(this.cart());
    return { messages: theirs, files: files.length };
  }

  /** Writes this cart's index row again (the buyer a row from before migration 0050 lacks). */
  async reindex(): Promise<boolean> {
    if (!this.state.cart) return false;
    await this.index(this.state.cart);
    return true;
  }

  /**
   * A staff cart for a customer who made a data subject request: where it ships, which names
   * them. Null when it holds no address.
   */
  async customerExport() {
    const c = this.state.cart;
    if (!c?.shipTo) return null;
    return { id: c.id, title: c.title, status: c.status, shipTo: c.shipTo, orderId: c.orderId };
  }

  /**
   * Removes the ship-to from a cart whose customer is being erased, and its tax exemption note; an
   * open cart is priced again without them. True if there was a ship-to to remove.
   */
  async eraseShipTo(): Promise<boolean> {
    if (!this.state.cart?.shipTo) return false;
    const c = this.cart();
    const final = isFinalCart(c);
    await this.save({
      ...c,
      shipTo: null,
      // The note names the customer's certificate, which their erasure deletes; an open cart is
      // priced again below, without the ship-to the certificate covered.
      issues: c.issues.filter((i) => i.code !== 'tax_exempt'),
      updatedAt: Date.now(),
      version: c.version + 1,
      // An ended cart isn't priced again; its quote stays what it was.
      quotedVersion: final && c.quotedVersion === c.version ? c.version + 1 : c.quotedVersion,
    });
    if (!final && !this.submitting) await this.reprice();
    return true;
  }

  /** What the buyer of this external cart put on it, for a data subject export. */
  async subjectExport() {
    const c = this.state.cart;
    if (!c?.external) return null;
    const guestId = `guest:${c.external.buyer.id}`;
    this.tables();
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      buyer: c.external.buyer,
      lines: c.lines.map(({ sku, qty, title }) => ({ sku, qty, title })),
      shipTo: c.shipTo ?? null,
      orderId: c.orderId,
      createdAt: c.createdAt,
      messages: this.sql<ChatRow>`SELECT * FROM cart_chat WHERE author_id = ${guestId} ORDER BY seq`
        .map(fromRow)
        .map(({ body, at }) => ({ body, at })),
      files: (this.state.attachments ?? [])
        .filter((a) => a.by.id === guestId)
        .map(({ name, type, size, at }) => ({ name, type, size, at })),
    };
  }

  /** Set while `submitAs` starts the order, so nothing else ends the cart meanwhile. */
  private submitting = false;

  // ── RPC (EngineApi) ──

  /** Makes this object the cart `init` describes; a second call returns the cart as it is. */
  async create(init: Cart): Promise<Cart> {
    if (this.state.cart) return this.state.cart;
    // Indexed first: a cart the index refuses (a second open of one session) never comes to be.
    await this.index(init);
    this.setState({ ...this.state, cart: init });
    if (init.external) await this.schedule(new Date(init.external.expiresAt), 'expire');
    // Before it's priced: a pricing failure must not leave a cart no one heard of.
    await this.announce('cart.created');
    if (init.lines.length) await this.reprice();
    return this.cart();
  }

  /** An external cart that hasn't gone back by its time is canceled. */
  async expire() {
    const c = this.state.cart;
    if (!c || isFinalCart(c) || !c.external) return;
    // Kept open since this was scheduled (`keepOpen` moves the schedule, so this is a fallback). A
    // schedule's time is in whole seconds, so it may fire up to one early.
    if (c.external.expiresAt - Date.now() > 1_000) {
      await this.scheduleExpiry(c.external.expiresAt);
      return;
    }
    // Mid-return: look again shortly, so a failed return can't outlive the cart's time.
    if (this.submitting) {
      await this.schedule(10, 'expire');
      return;
    }
    await this.save(finishCart(c, { status: 'canceled' }, Date.now()), 'cart.expired');
    for (const conn of this.getConnections()) conn.close(4410, 'Cart expired');
  }

  /** The one `expire` schedule, at `at`: the new one first, so the cart is never without one. */
  private async scheduleExpiry(at: number) {
    const next = await this.schedule(new Date(at), 'expire');
    for (const s of await this.listSchedules())
      if (s.callback === 'expire' && s.id !== next.id) await this.cancelSchedule(s.id);
  }

  /**
   * Keeps an external cart open while its buyer works on it: their socket connecting or calling
   * it, a search, or a file sent or fetched moves its time to its idle window from now
   * (`extendedCartExpiry`: at most once a minute, never past 24 hours from when it opened), and
   * its expiry with it. Staff activity doesn't: the idle window is the buyer's. Only while the
   * plugin that opened it may still have carts, so withdrawing that grant leaves the time it had.
   * Never fails the call it came with: a cart that isn't moved on just closes when it would have.
   */
  private async keepOpen() {
    const c = this.state.cart;
    if (!c?.external || this.submitting || extendedCartExpiry(c, Date.now()) === null) return;
    try {
      if (!(await mayUse(this.env, c.external.pluginId, 'carts:external'))) return;
      // Read again: the cart may have changed, ended or been moved on while that was checked.
      const now = this.state.cart;
      const until = now ? extendedCartExpiry(now, Date.now()) : null;
      if (!now?.external || until === null || this.submitting) return;
      // Not a change to the cart: its version (and so its quote) stays as it is.
      this.setState({
        ...this.state,
        cart: { ...now, external: { ...now.external, expiresAt: until } },
      });
      await this.scheduleExpiry(until);
      // Only the time, and only while the row says the cart is open: a cancel, return or erasure
      // indexing at the same time keeps the row it wrote.
      await this.env.DB.prepare(
        `UPDATE carts SET expires_at = ?1 WHERE id = ?2 AND status IN ('open', 'locked')`,
      )
        .bind(until, now.id)
        .run();
    } catch (err) {
      console.warn(`keeping cart ${c.id} open`, err);
    }
  }

  /** A request from the cart's buyer outside its socket (`EngineRpc.keepCartOpen`, attachAs). */
  async keepOpenFor(actor: CartActor): Promise<void> {
    if (actor?.kind === 'guest') await this.keepOpen();
  }

  /** How long a redeemed start link's buyer is let in for (`externalCartEnd`). */
  async admittedUntil(): Promise<number | null> {
    const c = this.state.cart;
    return c ? externalCartEnd(storedCart(c)) : null;
  }

  /** A start link for an open external cart's buyer (else null): works once, within `CART_START_TTL_MS`. */
  async issueStart(): Promise<string | null> {
    const c = this.state.cart;
    if (!c?.external || isFinalCart(c) || isCartExpired(c, Date.now())) return null;
    this.tables();
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    this.sql`DELETE FROM cart_starts WHERE expires_at < ${now}`;
    this
      .sql`INSERT INTO cart_starts (hash, expires_at) VALUES (${await sha256(token)}, ${now + CART_START_TTL_MS})`;
    return token;
  }

  /** The buyer a start link admits, or null for one that is unknown, used, expired or too late. */
  async redeemStart(token: string): Promise<CartGuest | null> {
    const c = this.state.cart;
    if (
      !c?.external ||
      isFinalCart(c) ||
      isCartExpired(c, Date.now()) ||
      typeof token !== 'string' ||
      token.length > 100
    )
      return null;
    this.tables();
    const hash = await sha256(token);
    const now = Date.now();
    const used = this.sql<{ hash: string }>`
      UPDATE cart_starts SET used_at = ${now}
      WHERE hash = ${hash} AND used_at IS NULL AND expires_at > ${now} RETURNING hash`;
    if (!used.length) return null;
    return { cartId: c.id, id: `guest:${c.external.buyer.id}`, name: c.external.buyer.name };
  }

  /**
   * Sends an external cart back to the buyer's system: priced and ready, it is held while the
   * plugin that opened it renders the return (`renderReturn`), then `returned`. The fields are
   * kept, so the buyer's page can post them again (`returnForm`) if it was closed meanwhile.
   */
  async transferAs(
    actor: CartActor,
  ): Promise<
    { ok: true; url: string; fields: Record<string, string> } | { ok: false; error: string }
  > {
    const c = this.cart();
    if (!c.external) return { ok: false, error: 'Only an external cart goes back to a buyer.' };
    // Only from the buyer's own page: its fields are posted from the browser that asked, and a
    // staff browser posting them would carry a staff session.
    if (actor.kind !== 'guest') return { ok: false, error: 'Only the buyer sends the cart back.' };
    if (isCartExpired(c, Date.now())) return { ok: false, error: 'The cart has closed.' };
    if (this.submitting) return { ok: false, error: 'The cart is being sent.' };
    const problem = cartReadyProblem(c);
    if (problem) return { ok: false, error: problem };
    const { pluginId, returnUrl } = c.external;
    const held = c;
    this.submitting = true;
    this.setState({ ...this.state, cart: { ...c, status: 'locked' } });
    try {
      if (!(await mayUse(this.env, pluginId, 'carts:external')))
        throw new Error('The plugin that opened this cart can no longer return it.');
      const stub = await pluginStub(this.env, pluginId, 'call');
      if (!stub) throw new Error(`Plugin “${pluginId}” is not installed.`);
      const view: PluginCart = {
        id: c.id,
        title: c.title,
        status: c.status,
        customerId: c.customerId,
        lines: c.lines,
        quote: c.quote,
        orderId: c.orderId,
        updatedAt: c.updatedAt,
        sessionRef: c.external.sessionRef,
      };
      const answer = await callPlugin(
        this.env,
        pluginId,
        stub.renderReturn({ cart: view }),
        `${pluginId}.renderReturn()`,
      );
      const checked = checkCartReturn(answer);
      if (!checked.ok) throw new Error(checked.error);
      this.tables();
      this
        .sql`INSERT OR REPLACE INTO cart_return (id, url, fields) VALUES (1, ${returnUrl}, ${JSON.stringify(checked.fields)})`;
      await this.save(finishCart(held, { status: 'returned' }, Date.now()), 'cart.returned');
      return { ok: true, url: returnUrl, fields: checked.fields };
    } catch (err) {
      this.setState({ ...this.state, cart: held });
      console.error(`returning cart ${c.id}`, err);
      return { ok: false, error: err instanceof Error ? err.message : 'The cart didn’t go back.' };
    } finally {
      this.submitting = false;
    }
  }

  async snapshot(): Promise<CartState | null> {
    return this.state.cart ? { ...this.state, cart: this.cart() } : null;
  }

  /** Applies `op` as `actor`; the socket's `apply` is this with the signed-in caller. */
  async applyAs(
    actor: CartActor,
    op: CartOp,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // While an order starts or a return renders, the cart is held as it was checked.
    if (this.submitting) return { ok: false, error: 'The cart is being sent.' };
    const now = Date.now();
    const tries =
      op.op === 'promo_add'
        ? ((await this.ctx.storage.get<number[]>('promo_tries')) ?? []).filter(
            (t) => now - t < PROMO_WINDOW_MS,
          )
        : [];
    if (tries.length >= PROMO_TRIES)
      return { ok: false, error: 'Too many promotion codes tried on this cart. Try again later.' };
    const r = applyCartOp(this.cart(), op, actor, now);
    if (!r.ok) return r;
    // Counted once a code is actually tried: a refusal (no right to edit, a closed cart, a code
    // already there) uses up nothing, so no one can spend the cart's tries for its buyer.
    if (op.op === 'promo_add') await this.ctx.storage.put('promo_tries', [...tries, now]);
    await this.save(r.cart);
    if (r.reprice) await this.reprice();
    return { ok: true };
  }

  /**
   * Starts the cart's order, once: the cart is held (`locked`, its version kept so the quote stays
   * current) while the order starts, so no op lands between the check and the start, and is
   * `submitted` once the order exists. The idempotency key is the cart's, so a retry after a
   * failure part-way finds the same order. The order ships where the cart was quoted for, with
   * the option the quote charged, as a completed checkout's does.
   */
  async submitAs(
    actor: CartActor,
    /** The version the person confirmed (a confirmed preview): refused when the cart moved on. */
    confirmedVersion?: number,
  ): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
    if (actor.kind !== 'staff' || !atLeast(actor.role, 'operator'))
      return { ok: false, error: 'This needs the Operator role.' };
    if (this.submitting) return { ok: false, error: 'The cart is being submitted.' };
    const c = this.cart();
    if (confirmedVersion !== undefined && c.version !== confirmedVersion)
      return { ok: false, error: CART_CHANGED_SINCE_CONFIRM };
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
          // What the quote charged, which is what the flow's shipping step will pick again.
          ...(q.shippingOption ? { shippingOption: q.shippingOption } : {}),
          meta: {
            cart: { id: c.id },
            ...(c.promoCodes.length ? { promoCodes: c.promoCodes } : {}),
            ...(c.shipTo ? { shipTo: c.shipTo } : {}),
          },
        },
      });
      if ('mismatch' in started) throw new Error('This cart already started a different order.');
      await this.save(
        finishCart(held, { status: 'submitted', orderId: started.orderId }, Date.now()),
        'cart.submitted',
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

  /** Adds a file the web app stored for this cart, as `actor`. */
  async attachAs(
    actor: CartActor,
    a: Omit<CartAttachment, 'by' | 'at'>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const c = this.cart();
    if (!canEditCart(c, actor)) return { ok: false, error: "You can't change this cart." };
    if (isFinalCart(c) || this.submitting) return { ok: false, error: `The cart is ${c.status}.` };
    if (a.key !== cartAttachmentKey(c.id, a.id))
      return { ok: false, error: 'That file isn’t this cart’s.' };
    const files = this.state.attachments ?? [];
    const problem = attachmentProblem(a, files.length);
    if (problem) return { ok: false, error: problem };
    const added: CartAttachment = {
      id: a.id,
      name: attachmentName(a.name),
      type: a.type,
      size: a.size,
      key: a.key,
      by: { id: actor.id, name: actor.name },
      at: Date.now(),
    };
    this.setState({ ...this.state, attachments: [...files, added] });
    await this.keepOpenFor(actor);
    return { ok: true };
  }

  /** Removes a file and deletes it, for whoever added it or staff who may change the cart. */
  @callable()
  async detach(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const actor = await this.caller();
    const c = this.cart();
    const files = this.state.attachments ?? [];
    const a = files.find((f) => f.id === id);
    if (!a) return { ok: false, error: 'That file is gone.' };
    if (isFinalCart(c)) return { ok: false, error: `The cart is ${c.status}.` };
    if (!canRemoveAttachment(a, actor))
      return { ok: false, error: 'Only who added it can remove it.' };
    this.setState({ ...this.state, attachments: files.filter((f) => f.id !== id) });
    await this.env.DOCS.delete(a.key);
    return { ok: true };
  }

  async cancelAs(actor: CartActor): Promise<{ ok: true } | { ok: false; error: string }> {
    if (actor.kind !== 'staff' || !atLeast(actor.role, 'operator'))
      return { ok: false, error: 'This needs the Operator role.' };
    if (this.submitting) return { ok: false, error: 'The cart is being submitted.' };
    const c = this.cart();
    if (isFinalCart(c)) return { ok: false, error: `The cart is ${c.status}.` };
    await this.save(finishCart(c, { status: 'canceled' }, Date.now()), 'cart.canceled');
    return { ok: true };
  }

  /**
   * Prices the cart as it is now with its flow's pricing nodes, for its ship-to and option. A
   * chosen option the quote doesn't offer stays chosen and is an error on the cart, as on a
   * checkout, so the person picks another rather than having one picked for them. A quote
   * finished after the cart changed again is dropped: the change that made it stale priced the
   * cart anew.
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
    const { quote, issues: found } = c.lines.length
      ? await quoteCheckout(this.env, flow, cartSession(c), cartDraftExtra(c))
      : { quote: null, issues: [] };
    const issues = [...found];
    // Codes on a cart whose flow never applies them would otherwise just sit there.
    if (c.promoCodes.length && !quoteNodes(flow).some((n) => n.type === 'commerce.discount'))
      issues.push({
        kind: 'warning',
        code: 'promotion',
        content:
          'This cart’s flow has no Apply promotions step, so its codes don’t change the price.',
        path: '$.promoCodes',
      });
    // A flow whose shipping step picks the cheapest or fastest charges that one, whatever was
    // chosen: say so rather than show a choice the order won't keep.
    if (c.shippingOption && quote?.shippingOption && quote.shippingOption !== c.shippingOption)
      issues.push({
        kind: 'warning',
        code: 'shipping_option',
        content: `This cart’s flow picks its own shipping option (“${quote.shippingOptions.find((o) => o.id === quote.shippingOption)?.title ?? quote.shippingOption}”), not “${c.shippingOption}”.`,
        path: '$.shippingOption',
      });
    if (this.state.cart?.version !== c.version) return;
    const now = this.cart();
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
    const guest = principal ? null : await forwardedGuest(this.env, ctx.request);
    const member: CartMember | null = principal
      ? { id: principal.id, name: principal.name, kind: 'staff' }
      : guest && guest.cartId === this.state.cart?.id
        ? { id: guest.id, name: guest.name, kind: 'guest' }
        : null;
    connection.setState({ principal, guest, member });
    this.syncMembers();
    await this.keepChecking();
    // The gate let only staff or this cart's buyer this far; only the buyer keeps it open.
    if (member?.kind === 'guest') await this.keepOpen();
  }

  override async onClose(connection: Connection<ConnectionState>) {
    const member = connection.state?.member;
    if (member) this.stopTyping(connection.id, member.id);
    else this.typed.delete(connection.id);
    this.syncMembers(connection.id);
  }

  /** No child agents: a `/sub/` path inside this one is refused (agent-routes.ts refuses it first). */
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response('Not found', { status: 404 });
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
      // A guest stays while their cart is open (or returned, to post it again, until its time)
      // and the plugin that opened it may still.
      if (c.state?.guest) {
        const cart = this.state.cart;
        const keep =
          !!cart?.external &&
          guestCartOpen({ status: cart.status, expiresAt: cart.external.expiresAt }, Date.now()) &&
          (await mayUse(this.env, cart.external.pluginId, 'carts:external'));
        if (keep) open++;
        else c.close(4410, 'Cart closed');
        continue;
      }
      const stored = c.state?.principal ?? null;
      // A check no one made: it doesn't keep the session from going idle.
      const p = stored ? await livePrincipal(this.env, stored, { touch: false }) : null;
      if (!p || !atLeast(p.role, 'viewer')) c.close(4401, 'Session ended');
      else open++;
    }
    this.syncMembers();
    // Counted afresh: a socket that opened while this ran found this job still queued and
    // scheduled none of its own.
    if (open || [...this.getConnections()].length)
      await this.schedule(CartAgent.RECHECK_S, 'recheckConnections');
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

  /**
   * The socket's caller as they are now, or throws (and closes a socket whose sign-in ended). A
   * buyer's call moves their cart's time on, except where `keepOpen` is false: that writes state.
   */
  private async caller({ keepOpen = true } = {}): Promise<CartActor> {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error('Call this over the cart’s socket.');
    const state = connection.state as ConnectionState | null;
    const guest = state?.guest;
    if (guest) {
      const c = this.cart();
      if (guest.cartId !== c.id || !c.external) throw new Error('This isn’t your cart.');
      if (!guestCartOpen({ status: c.status, expiresAt: c.external.expiresAt }, Date.now()))
        throw new Error('This cart has closed.');
      if (keepOpen) await this.keepOpen();
      return { kind: 'guest', id: guest.id, name: guest.name };
    }
    const stored = state?.principal ?? null;
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

  /** Changes per guest in a burst: each one prices the cart again. */
  private edits = new Map<string, number[]>();

  @callable()
  async apply(op: CartOp) {
    const actor = await this.caller();
    if (actor.kind === 'guest') {
      const now = Date.now();
      const recent = (this.edits.get(actor.id) ?? []).filter((t) => now - t < EDIT_WINDOW_MS);
      if (recent.length >= EDIT_BURST) return { ok: false as const, error: 'Slow down a moment.' };
      this.edits.set(actor.id, [...recent, now]);
    }
    return this.applyAs(actor, op);
  }

  @callable()
  async submit() {
    return this.submitAs(await this.caller());
  }

  @callable()
  async cancel() {
    return this.cancelAs(await this.caller());
  }

  /** Sends an external cart back to its buyer's system (`transferAs`). */
  @callable()
  async transfer() {
    return this.transferAs(await this.caller());
  }

  /** What a returned cart posted, to post again; null before it went back. */
  @callable()
  async returnForm(): Promise<{ url: string; fields: Record<string, string> } | null> {
    await this.caller();
    if (this.cart().status !== 'returned') return null;
    this.tables();
    const r = this.sql<{
      url: string;
      fields: string;
    }>`SELECT url, fields FROM cart_return WHERE id = 1`[0];
    return r ? { url: r.url, fields: JSON.parse(r.fields) as Record<string, string> } : null;
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
    this.stopTyping(getCurrentAgent().connection!.id, a.id);
    return { ok: true, id: m.id };
  }

  /**
   * When each socket last asked to say its person was typing, and whether that went out (a
   * refused caller's didn't): memory only, gone with the socket.
   */
  private typed = new Map<string, { at: number; sent: boolean }>();

  /**
   * Tells the others on the cart that the caller is writing a message, at most once every
   * `CART_TYPING_EVERY_MS` per socket (a call sooner is ignored, before anything is checked).
   * Whoever may post chat may say so, as `say` decides. It is sent, never stored: no state, no SQL,
   * and a buyer's typing doesn't move their cart's time on (their message will).
   */
  @callable()
  async typing(): Promise<boolean> {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error('Call this over the cart’s socket.');
    const now = Date.now();
    const last = this.typed.get(connection.id);
    if (last && now - last.at < CART_TYPING_EVERY_MS) return false;
    const mark = { at: now, sent: false };
    this.typed.set(connection.id, mark);
    const a = await this.caller({ keepOpen: false });
    // Sent the message or left while the caller was checked: that ended this notice already.
    if (this.typed.get(connection.id) !== mark) return false;
    mark.sent = true;
    this.sendTyping({
      type: 'cart_typing',
      memberId: a.id,
      name: a.name,
      until: now + CART_TYPING_MS,
    });
    return true;
  }

  /**
   * Ends a socket's typing notice, if it sent one that may still show: it posted, or left. With no
   * name: the page needs only the id, and an erased buyer's socket closing mustn't send theirs.
   */
  private stopTyping(connectionId: string, memberId: string) {
    const last = this.typed.get(connectionId);
    this.typed.delete(connectionId);
    if (last?.sent && Date.now() - last.at < CART_TYPING_MS)
      this.sendTyping({ type: 'cart_typing', memberId, name: '', until: 0 });
  }

  /**
   * To every socket the cart's state reaches (one with a member: staff the gate let in, or this
   * cart's buyer, each closed by `recheckConnections` once they may no longer read it), except the
   * typist's own. A buyer sees the same people in `members`, so a notice tells no one anything new.
   */
  private sendTyping(t: CartTyping) {
    const msg = JSON.stringify(t);
    for (const c of this.getConnections<ConnectionState>()) {
      const m = c.state?.member;
      if (m && m.id !== t.memberId) c.send(msg);
    }
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

  /**
   * The newest messages, oldest first, for drafting a staff reply (`draft_cart_reply`). Engine
   * only: never on the socket, where `history` checks who asks.
   */
  async recentChat(limit = 30): Promise<CartChatMessage[]> {
    limit = Math.min(Math.max(Math.trunc(limit) || 1, 1), CART_CHAT_BROADCAST);
    this.tables();
    return this.sql<ChatRow>`SELECT * FROM cart_chat ORDER BY seq DESC LIMIT ${limit}`
      .map(fromRow)
      .reverse();
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
