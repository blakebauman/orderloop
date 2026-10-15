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
      const state = (await env.ORDER_AGENT.getByName(o.id).snapshot()) as OrderState;
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
    truncated: rows.length > EXPORT_MAX,
    teamMember: s.teamMember,
  };
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
    teamMember: s.teamMember,
  };

  for (const o of list) {
    const erased = (await env.ORDER_AGENT.getByName(o.id).erasePersonalData(s.terms)) as {
      held: boolean;
      title: string;
    } | null;
    if (!erased) return { ok: false, reason: 'active_orders', orders: [o.id] };
    result.documents += await deletePrefix(env, `orders/${o.id}/`);
    // An order no agent holds (its title is all D1 has) is erased with the subject's terms.
    const title = erased.held ? erased.title : eraseText(o.title, s.terms);
    await s.db
      .update(orders)
      .set({ contactEmail: null, title, erasedAt: Date.now() })
      .where(eq(orders.id, o.id));
    result.orders++;
  }
  for (const c of chunks(list.map((o) => o.id))) {
    await s.db.delete(documents).where(inArray(documents.orderId, c));
    await s.db.delete(webhookDeliveries).where(inArray(webhookDeliveries.orderId, c));
    result.messages += (
      await s.db
        .update(messages)
        .set({ recipient: ERASED, subject: ERASED, body: ERASED })
        .where(inArray(messages.orderId, c))
        .returning({ id: messages.id })
    ).length;
    result.inboundEmails += (
      await s.db
        .update(inboundEmails)
        .set({ sender: ERASED, subject: '', r2Key: null })
        .where(inArray(inboundEmails.orderId, c))
        .returning({ id: inboundEmails.id })
    ).length;
  }
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
