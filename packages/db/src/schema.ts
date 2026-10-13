/** Must match migrations/*.sql column for column and index for index. Add a numbered migration; never edit an applied one. */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const flows = sqliteTable('flows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  orderType: text('order_type').notNull(),
  graphJson: text('graph_json').notNull(),
  publishedVersion: integer('published_version'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const flowVersions = sqliteTable(
  'flow_versions',
  {
    flowId: text('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    flowJson: text('flow_json').notNull(),
    publishedAt: integer('published_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.flowId, t.version] })],
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull().default(''),
    flowId: text('flow_id').notNull(),
    flowVersion: integer('flow_version').notNull(),
    instanceId: text('instance_id'),
    generation: integer('generation').notNull().default(1),
    customerId: text('customer_id'),
    currency: text('currency').notNull().default('USD'),
    total: real('total').notNull().default(0),
    waitingOn: text('waiting_on'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    idempotencyKey: text('idempotency_key'),
    idempotencyFingerprint: text('idempotency_fingerprint'),
    fxRate: real('fx_rate').notNull().default(1),
  },
  (t) => [
    index('orders_status').on(t.status, t.updatedAt),
    index('orders_type').on(t.type, t.updatedAt),
    uniqueIndex('orders_idempotency')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    nodeId: text('node_id').notNull(),
    eventType: text('event_type').notNull(),
    title: text('title').notNull(),
    assignee: text('assignee').notNull().default(''),
    amount: real('amount'),
    status: text('status').notNull().default('pending'),
    note: text('note'),
    requestedAt: integer('requested_at').notNull(),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'),
  },
  (t) => [
    index('approvals_status').on(t.status, t.requestedAt),
    // One approval row per wait: a replayed `openWait` can't insert a second.
    uniqueIndex('approvals_wait').on(t.orderId, t.eventType),
  ],
);

export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  tier: text('tier').notNull().default('standard'),
  creditLimit: real('credit_limit').notNull().default(0),
  balance: real('balance').notNull().default(0),
  terms: text('terms').notNull().default('net_30'),
});

export const products = sqliteTable('products', {
  sku: text('sku').primaryKey(),
  name: text('name').notNull(),
  price: real('price').notNull(),
  cost: real('cost').notNull(),
  stock: integer('stock').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  reorderPoint: integer('reorder_point').notNull().default(0),
  reorderQty: integer('reorder_qty').notNull().default(0),
  supplier: text('supplier').notNull().default(''),
});

export const contractPrices = sqliteTable(
  'contract_prices',
  {
    customerId: text('customer_id').notNull(),
    sku: text('sku').notNull(),
    price: real('price').notNull(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.sku] })],
);

export const reservations = sqliteTable(
  'reservations',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    sku: text('sku').notNull(),
    qty: integer('qty').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('reservations_order').on(t.orderId)],
);

/** One row per finished node run, for per-node timing. Written by the OrderAgent. */
export const nodeRuns = sqliteTable(
  'node_runs',
  {
    orderId: text('order_id').notNull(),
    generation: integer('generation').notNull(),
    nodeId: text('node_id').notNull(),
    run: integer('run').notNull(),
    nodeType: text('node_type').notNull(),
    orderType: text('order_type').notNull(),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.generation, t.nodeId, t.run] }),
    index('node_runs_type').on(t.nodeType, t.endedAt),
  ],
);

/** Units of each currency per one base currency (USD), for per-order currency. */
export const fxRates = sqliteTable('fx_rates', {
  currency: text('currency').primaryKey(),
  rate: real('rate').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** The pricing chain's sources, run in `priority` order; see `resolvePrice` in core. */
export const priceSources = sqliteTable('price_sources', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  priority: integer('priority').notNull(),
  stopProcessing: integer('stop_processing', { mode: 'boolean' }).notNull().default(true),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

/** Price-book and volume entries. Empty scope columns match anything. */
export const priceRules = sqliteTable(
  'price_rules',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => priceSources.id),
    name: text('name').notNull(),
    sku: text('sku'),
    customerId: text('customer_id'),
    customerTier: text('customer_tier'),
    minQty: real('min_qty'),
    price: real('price'),
    discountPct: real('discount_pct'),
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('price_rules_source').on(t.sourceId)],
);

/** Inventory changes keyed by step and line; `applied` makes each one count exactly once. */
export const stockMovements = sqliteTable(
  'stock_movements',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    sku: text('sku').notNull(),
    kind: text('kind').notNull(),
    qty: real('qty').notNull(),
    applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('stock_movements_order').on(t.orderId)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    kind: text('kind').notNull(),
    amount: real('amount').notNull(),
    status: text('status').notNull(),
    ref: text('ref'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('payments_order').on(t.orderId)],
);

export const shipments = sqliteTable(
  'shipments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    carrier: text('carrier').notNull(),
    tracking: text('tracking').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('shipments_order').on(t.orderId)],
);

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    kind: text('kind').notNull(),
    r2Key: text('r2_key').notNull(),
    contentType: text('content_type').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('documents_order').on(t.orderId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_order').on(t.orderId)],
);

export const webhookSubscriptions = sqliteTable('webhook_subscriptions', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  /** JSON array of event names; "*" matches every event. */
  events: text('events').notNull().default('["*"]'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    subscriptionId: text('subscription_id').notNull(),
    orderId: text('order_id').notNull(),
    event: text('event').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [
    index('webhook_deliveries_order').on(t.orderId),
    index('webhook_deliveries_subscription').on(t.subscriptionId, t.createdAt),
  ],
);

export const inboundEmails = sqliteTable(
  'inbound_emails',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    mailbox: text('mailbox').notNull(),
    sender: text('sender').notNull(),
    subject: text('subject').notNull().default(''),
    status: text('status').notNull(),
    reason: text('reason'),
    orderId: text('order_id'),
    r2Key: text('r2_key'),
    attachments: integer('attachments').notNull().default(0),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => [
    uniqueIndex('inbound_emails_message').on(t.messageId),
    index('inbound_emails_received').on(t.receivedAt),
  ],
);

/** People with a role; see ROLES in core. `password_hash` is PBKDF2 (`pbkdf2:<iter>:<salt>:<hash>`). */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    passwordHash: text('password_hash'),
    /** An outside identity provider's subject, once that sign-in exists. */
    externalSub: text('external_sub'),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
    disabledAt: integer('disabled_at'),
  },
  (t) => [
    uniqueIndex('users_email').on(t.email),
    uniqueIndex('users_external_sub').on(t.externalSub).where(sql`${t.externalSub} IS NOT NULL`),
  ],
);

/** Signed-in sessions; the cookie holds a random token and only its SHA-256 is stored. */
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/** REST API bearer tokens (`ol_live_…`), stored as SHA-256, each with a role. */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    role: text('role').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    /** When the token stops working; null never expires. */
    expiresAt: integer('expires_at'),
  },
  (t) => [uniqueIndex('api_tokens_hash').on(t.tokenHash)],
);

/** Failed authentication attempts per key in a fixed window; see `throttle.ts` in the web app. */
export const authFailures = sqliteTable('auth_failures', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: integer('window_start').notNull(),
});

/** Security audit log, written by the web app (`audit.server.ts`); kept 180 days. */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull(),
    action: text('action').notNull(),
    /** Who acted, as the audit trail names them (email, `token:<name>`, `operator`); null if nobody signed in. */
    actor: text('actor'),
    actorId: text('actor_id'),
    actorKind: text('actor_kind'),
    /** What it acted on, e.g. a person's email or a token's name. */
    target: text('target'),
    /** JSON with action-specific fields, e.g. `{ "from": "viewer", "to": "approver" }`. */
    detail: text('detail'),
    ip: text('ip'),
  },
  (t) => [index('audit_events_at').on(t.at), index('audit_events_action').on(t.action, t.at)],
);
