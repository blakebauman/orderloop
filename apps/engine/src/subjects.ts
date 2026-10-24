/**
 * Data subject requests (`erasure.ts` in core): find everything held about one person by their
 * email address, then export it or erase it. A person is a customer account with that email, a
 * guest buyer who gave it, or a sender whose email started an order. Erasing works through their
 * orders a batch at a time; the customer accounts and the rest go once no order is left.
 */

import {
  ERASED,
  type ErasureResult,
  erasedCustomerEmail,
  eraseText,
  erasureTerms,
  type OrderState,
  type SubjectExport,
  subjectEmail,
  TERMINAL_ORDER_STATUSES,
} from '@orderloop/core';
import {
  carts,
  createDb,
  customers,
  documents,
  inboundEmails,
  messages,
  orders,
  users,
  webhookDeliveries,
} from '@orderloop/db';
import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import { cartAgent, orderAgent } from './namespaces';
import { checkoutsOf, deleteCheckoutsOf, scrubCheckouts } from './ucp/subjects';

/** Orders erased per call; the caller repeats until `done`. */
const ERASE_BATCH = 100;
/** Orders in one export. */
const EXPORT_MAX = 500;
/** D1 binds at most 100 parameters a statement. */
const CHUNK = 90;

const chunks = <T>(xs: T[]) =>
  Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) =>
    xs.slice(i * CHUNK, (i + 1) * CHUNK),
  );

const lower = (column: SQLWrapper, email: string) => sql`lower(${column}) = ${email}`;

async function subject(env: Env, raw: string) {
  const db = createDb(env.DB);
  const email = subjectEmail(raw);
  const accounts = await db.select().from(customers).where(lower(customers.email, email));
  const sent = await db
    .select({ orderId: inboundEmails.orderId })
    .from(inboundEmails)
    .where(lower(inboundEmails.sender, email));
  const viaEmail = sent.flatMap((r) => (r.orderId ? [r.orderId] : []));
  const ids = accounts.map((c) => c.id);
  /** The subject's orders that aren't erased yet. */
  const theirs = or(
    lower(orders.contactEmail, email),
    ...chunks(ids).map((c) => inArray(orders.customerId, c)),
    ...chunks(viaEmail).map((c) => inArray(orders.id, c)),
  );
  const team = await db.select({ id: users.id }).from(users).where(lower(users.email, email)).get();
  return {
    db,
    email,
    accounts,
    theirs: and(isNull(orders.erasedAt), theirs)!,
    teamMember: !!team,
    terms: erasureTerms([email, ...accounts.map((c) => c.name)]),
  };
}

export async function exportDataSubject(env: Env, raw: string): Promise<SubjectExport> {
  const s = await subject(env, raw);
  const rows = await s.db
    .select()
    .from(orders)
    .where(s.theirs)
    .limit(EXPORT_MAX + 1);
  const list = rows.slice(0, EXPORT_MAX);
  const orderIds = list.map((o) => o.id);
  const withState = await Promise.all(
    list.map(async (o) => {
      const state = (await orderAgent(env, o.id).snapshot()) as OrderState;
      const order = state.order;
      return {
        id: o.id,
        status: o.status,
        channel: o.channel,
        externalId: o.externalId,
        createdAt: o.createdAt,
        customerId: o.customerId,
        title: order?.title ?? o.title,
        contact: order?.contact,
        lines: order?.lines,
        currency: o.currency,
        total: o.total,
        meta: order?.meta,
      };
    }),
  );
  const byOrder = <T>(column: Parameters<typeof inArray>[0], q: (where: SQL) => Promise<T[]>) =>
    Promise.all(chunks(orderIds).map((c) => q(inArray(column, c)))).then((r) => r.flat());
  const [msgs, sentTo, docs, inbound] = await Promise.all([
    byOrder(messages.orderId, (w) => s.db.select().from(messages).where(w)),
    s.db.select().from(messages).where(lower(messages.recipient, s.email)),
    byOrder(documents.orderId, (w) => s.db.select().from(documents).where(w)),
    s.db.select().from(inboundEmails).where(lower(inboundEmails.sender, s.email)),
  ]);
  const uniqueMessages = [...new Map([...msgs, ...sentTo].map((m) => [m.id, m])).values()];
  return {
    email: s.email,
    exportedAt: Date.now(),
    customers: s.accounts.map(({ stripePaymentMethodId: _pm, ...c }) => c),
    orders: withState,
    messages: uniqueMessages,
    inboundEmails: inbound.map(({ r2Key: _key, ...r }) => r),
    documents: docs.map((d) => ({
      key: d.r2Key,
      kind: d.kind,
      contentType: d.contentType,
      createdAt: d.createdAt,
    })),
    checkouts: (await checkoutsOf(env, s.email)).map(
      ({ id, status, buyer, shipTo, lines, orderId, createdAt }) => ({
        id,
        status,
        buyer,
        shipTo,
        lines,
        orderId,
        createdAt,
      }),
    ),
    carts: (
      await Promise.all(
        (await cartsOf(env, s.email)).map((id) => cartAgent(env, id).subjectExport()),
      )
    )
      .filter((c) => c !== null)
      // Plain data, not the RPC result it came in.
      .map((c) => JSON.parse(JSON.stringify(c)) as Record<string, unknown>),
    truncated: rows.length > EXPORT_MAX,
    teamMember: s.teamMember,
  };
}

/** External carts whose buyer is the subject (`carts.buyer_id`, written lower-cased). */
async function cartsOf(env: Env, email: string) {
  const rows = await createDb(env.DB)
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.buyerId, email))
    .limit(EXPORT_MAX);
  return rows.map((r) => r.id);
}

export async function eraseDataSubject(env: Env, raw: string): Promise<ErasureResult> {
  const s = await subject(env, raw);
  const active = await s.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(s.theirs, notInArray(orders.status, TERMINAL_ORDER_STATUSES)))
    .limit(20);
  if (active.length) return { ok: false, reason: 'active_orders', orders: active.map((o) => o.id) };

  const batch = await s.db
    .select()
    .from(orders)
    .where(s.theirs)
    .limit(ERASE_BATCH + 1);
  const list = batch.slice(0, ERASE_BATCH);
  const result = {
    ok: true as const,
    done: batch.length <= ERASE_BATCH,
    orders: 0,
    customers: 0,
    documents: 0,
    messages: 0,
    inboundEmails: 0,
    carts: 0,
    teamMember: s.teamMember,
  };

  // Their external carts: each loses their messages and files, and stops naming them.
  for (const id of await cartsOf(env, s.email)) {
    await cartAgent(env, id).eraseSubject(s.terms);
    result.carts++;
  }

  const erased = await eraseOrders(env, list, s.terms);
  if (erased.refused.length) return { ok: false, reason: 'active_orders', orders: erased.refused };
  Object.assign(result, {
    orders: erased.orders,
    documents: erased.documents,
    messages: erased.messages,
    inboundEmails: erased.inboundEmails,
  });
  if (!result.done) return result;

  // No order left: what isn't tied to one, then the accounts themselves.
  const unlinked = await s.db
    .select()
    .from(inboundEmails)
    .where(lower(inboundEmails.sender, s.email));
  for (const r of unlinked) if (r.r2Key) result.documents += await deletePrefix(env, r.r2Key);
  result.inboundEmails += (
    await s.db
      .update(inboundEmails)
      .set({ sender: ERASED, subject: '', r2Key: null })
      .where(lower(inboundEmails.sender, s.email))
      .returning({ id: inboundEmails.id })
  ).length;
  result.messages += (
    await s.db
      .update(messages)
      .set({ recipient: ERASED, subject: ERASED, body: ERASED })
      .where(lower(messages.recipient, s.email))
      .returning({ id: messages.id })
  ).length;
  await deleteCheckoutsOf(env, s.email);
  for (const c of s.accounts) {
    await s.db
      .update(customers)
      .set({
        name: 'Erased customer',
        email: erasedCustomerEmail(c.id),
        stripeCustomerId: null,
        stripePaymentMethodId: null,
      })
      .where(eq(customers.id, c.id));
    result.customers++;
  }
  return result;
}

type OrderRow = typeof orders.$inferSelect;

/**
 * Erases the buyer from finished orders: each order's agent state (`erasePersonalData`), its R2
 * documents and document rows, its webhook deliveries, the checkout session that placed it, and
 * the messages and intake rows that belong to it. `terms` are the subject's words to erase besides each order's own contact; the
 * retention sweep passes none. An order running again is skipped and named in `refused`.
 */
export async function eraseOrders(
  env: Env,
  list: Pick<OrderRow, 'id' | 'title'>[],
  terms: string[],
) {
  const db = createDb(env.DB);
  const result = {
    orders: 0,
    documents: 0,
    messages: 0,
    inboundEmails: 0,
    refused: [] as string[],
  };
  const done: string[] = [];
  for (const o of list) {
    const erased = (await orderAgent(env, o.id).erasePersonalData(terms)) as {
      held: boolean;
      title: string;
    } | null;
    if (!erased) {
      result.refused.push(o.id);
      continue;
    }
    result.documents += await deletePrefix(env, `orders/${o.id}/`);
    // An order no agent holds (its title is all D1 has) is erased with the subject's terms, and
    // loses its indexed reason, free text that may name them. A held order's agent re-indexed it.
    const title = erased.held ? erased.title : eraseText(o.title, terms);
    await db
      .update(orders)
      .set({
        contactEmail: null,
        title,
        ...(erased.held ? {} : { reason: null }),
        erasedAt: Date.now(),
      })
      .where(eq(orders.id, o.id));
    done.push(o.id);
    result.orders++;
  }
  for (const c of chunks(done)) {
    await scrubCheckouts(env, c);
    await db.delete(documents).where(inArray(documents.orderId, c));
    await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.orderId, c));
    result.messages += (
      await db
        .update(messages)
        .set({ recipient: ERASED, subject: ERASED, body: ERASED })
        .where(inArray(messages.orderId, c))
        .returning({ id: messages.id })
    ).length;
    result.inboundEmails += (
      await db
        .update(inboundEmails)
        .set({ sender: ERASED, subject: '', r2Key: null })
        .where(inArray(inboundEmails.orderId, c))
        .returning({ id: inboundEmails.id })
    ).length;
  }
  return result;
}

/** Deletes every R2 object under `prefix` (or the one object it names). Returns how many. */
async function deletePrefix(env: Env, prefix: string) {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DOCS.list({ prefix, cursor });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.DOCS.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
