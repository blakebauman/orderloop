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
  model: text('model').notNull(),
  /** JSON array of the channels the flow is meant for. */
  channels: text('channels').notNull().default('[]'),
  graphJson: text('graph_json').notNull(),
  publishedVersion: integer('published_version'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** When a never-published draft was archived out of the flows list; null otherwise. */
  archivedAt: integer('archived_at'),
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
    /** Who published it, as the audit trail names them; null for built-in templates. */
    publishedBy: text('published_by'),
  },
  (t) => [primaryKey({ columns: [t.flowId, t.version] })],
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    model: text('model').notNull(),
    channel: text('channel').notNull().default('api'),
    /** The order's id in the channel it came from. */
    externalId: text('external_id'),
    /** A guest buyer's email, so orders without a customer can be found. */
    contactEmail: text('contact_email'),
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
    /** The labels of the steps holding the order's open waits, joined with ` · `. */
    waitingAt: text('waiting_at'),
    /** When the oldest open wait began. */
    waitingSince: integer('waiting_since'),
    /**
     * What the open waits are on, joined with ` · `: `person:<role>` (role empty when unassigned),
     * `event:<name>` or `timer`.
     */
    waitingFor: text('waiting_for'),
    /** For a failed, rolled-back, declined or cancelled order: the labels of the steps that failed. */
    stoppedAt: text('stopped_at'),
    /** Why a failed, rolled-back, declined or cancelled order ended. */
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    idempotencyKey: text('idempotency_key'),
    idempotencyFingerprint: text('idempotency_fingerprint'),
    fxRate: real('fx_rate').notNull().default(1),
    /** The principal id that started it; null for channels, email and the stock review. */
    startedBy: text('started_by'),
    /** When a data subject erasure removed the buyer from it. */
    erasedAt: integer('erased_at'),
  },
  (t) => [
    index('orders_status').on(t.status, t.updatedAt),
    index('orders_model').on(t.model, t.updatedAt),
    index('orders_created').on(t.createdAt),
    index('orders_updated').on(t.updatedAt),
    index('orders_channel_external')
      .on(t.channel, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
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

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** business | consumer | internal. Only business customers buy on account. */
    kind: text('kind').notNull().default('business'),
    tier: text('tier').notNull().default('standard'),
    creditLimit: real('credit_limit').notNull().default(0),
    balance: real('balance').notNull().default(0),
    terms: text('terms').notNull().default('net_30'),
    /** The customer's Stripe customer (cus_…), created on their first `verify` authorization. */
    stripeCustomerId: text('stripe_customer_id'),
    /** The card a `verify` authorization saved, which renewals charge off-session. */
    stripePaymentMethodId: text('stripe_payment_method_id'),
  },
  (t) => [
    index('customers_email').on(sql`lower(${t.email})`),
    uniqueIndex('customers_stripe_customer')
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} IS NOT NULL`),
  ],
);

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
  /** Marketplace seller; null when the operator sells it. */
  sellerId: text('seller_id'),
  /** physical | digital. Digital goods hold no stock and are delivered as entitlements. */
  kind: text('kind').notNull().default('physical'),
  /**
   * When the catalog last set this row's name and price (ms); null for rows it never wrote. The
   * catalog's changes can arrive out of order: only a newer one applies.
   */
  catalogAt: integer('catalog_at'),
});

/** A store that holds its own stock, for pickup, ship-from-store and point of sale. */
export const locations = sqliteTable('locations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('store'),
  postalCode: text('postal_code').notNull().default(''),
  pickup: integer('pickup', { mode: 'boolean' }).notNull().default(true),
  ships: integer('ships', { mode: 'boolean' }).notNull().default(false),
  /** Where the store is, for shipping from the store nearest the customer. */
  latitude: real('latitude'),
  longitude: real('longitude'),
});

export const locationStock = sqliteTable(
  'location_stock',
  {
    locationId: text('location_id').notNull(),
    sku: text('sku').notNull(),
    stock: integer('stock').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.locationId, t.sku] })],
);

/** A delivered digital good: licence key, download or gift card code. Status: issued | revoked. */
export const entitlements = sqliteTable(
  'entitlements',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    sku: text('sku').notNull(),
    code: text('code').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('entitlements_order').on(t.orderId)],
);

export const sellers = sqliteTable('sellers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  commissionPct: real('commission_pct').notNull().default(0.15),
  autoAccept: integer('auto_accept', { mode: 'boolean' }).notNull().default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
});

/** The part of an order one seller fulfils. Status: pending | accepted | rejected | cancelled. */
export const sellerOrders = sqliteTable(
  'seller_orders',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    sellerId: text('seller_id').notNull(),
    status: text('status').notNull(),
    /** JSON array of the order lines this seller fulfils. */
    lines: text('lines').notNull(),
    subtotal: real('subtotal').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (t) => [index('seller_orders_order').on(t.orderId)],
);

/** Money owed to a seller for an order. Status: scheduled | reversed | paid. */
export const payouts = sqliteTable(
  'payouts',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    sellerId: text('seller_id').notNull(),
    gross: real('gross').notNull(),
    commission: real('commission').notNull(),
    refunded: real('refunded').notNull().default(0),
    net: real('net').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('payouts_order').on(t.orderId),
    index('payouts_seller').on(t.sellerId, t.createdAt),
  ],
);

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
    /** Null for central stock; otherwise the store holding it. */
    locationId: text('location_id'),
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
    model: text('model').notNull(),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.generation, t.nodeId, t.run] }),
    index('node_runs_type').on(t.nodeType, t.endedAt),
    index('node_runs_ended').on(t.endedAt),
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

/** One change to a customer's balance, keyed by the step that made it. */
export const balanceEntries = sqliteTable(
  'balance_entries',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    customerId: text('customer_id').notNull(),
    amount: real('amount').notNull(),
    applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('balance_entries_customer').on(t.customerId, t.createdAt),
    index('balance_entries_order').on(t.orderId),
  ],
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
    locationId: text('location_id'),
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
    /** mock | stripe | external (the channel took the money) | offline (cash, terms, a till). */
    provider: text('provider').notNull().default('mock'),
    /** The processor's id: a PaymentIntent (pi_…) or a Refund (re_…). */
    externalId: text('external_id'),
    currency: text('currency'),
  },
  (t) => [
    index('payments_order').on(t.orderId),
    index('payments_status_created').on(t.status, t.createdAt),
    index('payments_external').on(t.externalId).where(sql`${t.externalId} IS NOT NULL`),
  ],
);

/** A sandboxed plugin version an admin installed at runtime from a signed bundle. */
export const installedPlugins = sqliteTable(
  'installed_plugins',
  {
    id: text('id').notNull(),
    sha: text('sha').notNull(),
    version: text('version').notNull(),
    publisher: text('publisher').notNull(),
    manifest: text('manifest').notNull(),
    status: text('status').notNull(),
    personalDataGranted: integer('personal_data_granted').notNull().default(0),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedAt: integer('uploaded_at').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: integer('approved_at'),
    /** An assistant draft's: the admin's instruction. */
    request: text('request'),
    /** An assistant draft's test cases and their last results (JSON). */
    cases: text('cases'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.sha] }),
    index('installed_plugins_status').on(t.status),
    uniqueIndex('installed_plugins_version').on(t.id, t.version),
    uniqueIndex('installed_plugins_running')
      .on(t.id)
      .where(sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/** A secret an admin entered for a runtime-installed plugin, sealed with DATA_KEY. */
export const pluginSecrets = sqliteTable(
  'plugin_secrets',
  {
    pluginId: text('plugin_id').notNull(),
    name: text('name').notNull(),
    value: text('value').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pluginId, t.name] })],
);

/** A sandboxed plugin's latest exceptions (its Tail Worker), scrubbed; 100 kept per plugin. */
export const pluginErrors = sqliteTable(
  'plugin_errors',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id').notNull(),
    message: text('message').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('plugin_errors_plugin').on(t.pluginId, t.at)],
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
    /** The provider plugin that labelled it, and its id for the label; null when built in. */
    provider: text('provider'),
    externalId: text('external_id'),
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

/**
 * Outbound webhook subscriptions. Secrets are stored encrypted (`encryptSecret` in @orderloop/core).
 * A rotated-out secret still signs deliveries, beside the new one, until `previous_expires_at`.
 */
export const webhookSubscriptions = sqliteTable('webhook_subscriptions', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  previousSecret: text('previous_secret'),
  previousExpiresAt: integer('previous_expires_at'),
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
    index('webhook_deliveries_created').on(t.createdAt),
  ],
);

/**
 * External systems that sign webhooks, each with its own secret and scope (`IntegrationScope` in
 * @orderloop/core). Secrets are stored encrypted. A rotated-out secret keeps working until
 * `previous_expires_at`. Revoking keeps the row, so the audit log's references still resolve.
 */
export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  secret: text('secret').notNull(),
  previousSecret: text('previous_secret'),
  previousExpiresAt: integer('previous_expires_at'),
  /** JSON array of event names; "*" matches every event. */
  events: text('events').notNull().default('[]'),
  startOrders: integer('start_orders', { mode: 'boolean' }).notNull().default(false),
  /** JSON array of flow ids an order may name; "*" matches every flow. */
  flows: text('flows').notNull().default('[]'),
  channel: text('channel'),
  createdAt: integer('created_at').notNull(),
  createdBy: text('created_by'),
  lastUsedAt: integer('last_used_at'),
  revokedAt: integer('revoked_at'),
});

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
    /** The identity provider's subject for single sign-on, linked on first SSO sign-in. */
    externalSub: text('external_sub'),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
    disabledAt: integer('disabled_at'),
    /** Authenticator-app secret (base32, stored encrypted), set once two-factor sign-in is on. */
    totpSecret: text('totp_secret'),
    totpEnabledAt: integer('totp_enabled_at'),
    /** The last 30-second step a code was accepted for; older or equal steps are refused. */
    totpLastStep: integer('totp_last_step'),
    /** The password was set by an operator (first or reset); the person must choose their own. */
    passwordChangeDue: integer('password_change_due', { mode: 'boolean' }).notNull().default(false),
    /** The identity provider's own id for this person, as SCIM provisioning sent it. */
    scimExternalId: text('scim_external_id'),
  },
  (t) => [
    uniqueIndex('users_email').on(t.email),
    uniqueIndex('users_external_sub').on(t.externalSub).where(sql`${t.externalSub} IS NOT NULL`),
  ],
);

/** Groups the identity provider pushes over SCIM; admins map them to roles. */
export const scimGroups = sqliteTable('scim_groups', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  externalId: text('external_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const scimGroupMembers = sqliteTable(
  'scim_group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => scimGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('scim_group_members_user').on(t.userId),
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
    /** Last request on this session (updated at most every few minutes); null means `created_at`. */
    lastSeenAt: integer('last_seen_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId), index('sessions_expires').on(t.expiresAt)],
);

/** One-use two-factor recovery codes, stored as SHA-256; a row is deleted when its code is used. */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('recovery_codes_user').on(t.userId)],
);

/**
 * A correct password from someone with two-factor on, waiting for their code. The
 * `__Host-ol_2fa` cookie holds a random token; only its SHA-256 is stored.
 */
export const signInChallenges = sqliteTable('sign_in_challenges', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/**
 * Passkeys (WebAuthn credentials): signing in with one, with user verification, takes the place of
 * a password and code. `id` is the credential id and `public_key` its COSE key, both base64url.
 */
export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    publicKey: text('public_key').notNull(),
    /** The authenticator's signature counter; a lower one than stored means a cloned key. */
    counter: integer('counter').notNull().default(0),
    /** JSON array of transports (usb, nfc, ble, internal, hybrid), as the browser reported. */
    transports: text('transports').notNull().default('[]'),
    name: text('name').notNull(),
    /** Synced by a password manager or platform, rather than bound to one device. */
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user').on(t.userId)],
);

/**
 * The challenge a passkey registration or sign-in must answer, used once. A sign-in's id is the
 * SHA-256 of its cookie; a registration's is `reg:<user id>`.
 */
export const passkeyChallenges = sqliteTable('passkey_challenges', {
  id: text('id').primaryKey(),
  challenge: text('challenge').notNull(),
  userId: text('user_id'),
  expiresAt: integer('expires_at').notNull(),
});

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

/** Settings operators change in the app; `key` names one, e.g. `two_factor_required`. */
export const workspaceSettings = sqliteTable('workspace_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** Who changed it, as the audit trail names them. */
  updatedBy: text('updated_by').notNull(),
});

/** Signed webhook events already delivered, by signature; pruned after the signature window. */
export const webhookReceipts = sqliteTable(
  'webhook_receipts',
  {
    id: text('id').primaryKey(),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => [index('webhook_receipts_received').on(t.receivedAt)],
);

/**
 * Invoices issued through Stripe (`commerce.invoice` with provider "stripe"). Written before Stripe
 * is called, with the due date it asks for, so a retried step repeats the same request.
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    /** stripe | mock (provider "stripe" while PAYMENTS_MODE is "mock"). */
    provider: text('provider').notNull(),
    /** pending (nothing in Stripe yet) | draft | open | paid | void. */
    status: text('status').notNull(),
    /** The Stripe invoice (in_…). */
    externalId: text('external_id'),
    number: text('number'),
    /** Stripe's hosted invoice page, where the customer pays. */
    hostedUrl: text('hosted_url'),
    amount: real('amount').notNull(),
    currency: text('currency').notNull(),
    terms: text('terms').notNull(),
    dueAt: integer('due_at'),
    /** The account charge this invoice made (`balance_entries`), settled when it is paid. */
    balanceEntryId: text('balance_entry_id'),
    createdAt: integer('created_at').notNull(),
    paidAt: integer('paid_at'),
  },
  (t) => [
    index('invoices_order').on(t.orderId),
    uniqueIndex('invoices_external').on(t.externalId).where(sql`${t.externalId} IS NOT NULL`),
  ],
);

/** Payment provider events already handled, by event id; kept 30 days (Stripe retries for 3). */
export const paymentEvents = sqliteTable(
  'payment_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    type: text('type').notNull(),
    orderId: text('order_id'),
    receivedAt: integer('received_at').notNull(),
  },
  (t) => [index('payment_events_received').on(t.receivedAt)],
);

/** Failed authentication attempts per key in a fixed window; see `throttle.ts` in the web app. */
export const authFailures = sqliteTable('auth_failures', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: integer('window_start').notNull(),
});

/**
 * The audit log, written by the web app (`audit.server.ts`) and the engine (`audit.ts`) through
 * `appendAudit`. Append-only: the database refuses updates, and deletes of events younger than 90
 * days (triggers in migration 0034). The engine's daily sweep archives events past the retention
 * to R2 and then deletes them. Each event is sealed into a hash chain (`seq`, `prevHash`, `hash`;
 * `sealAuditRow` in core); events from before migration 0034 have none.
 */
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
    /** Its place in the chain, from 1; unique. */
    seq: integer('seq'),
    /** The hash of the event before it, or `genesis` for the first. */
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (t) => [
    index('audit_events_at').on(t.at),
    index('audit_events_action').on(t.action, t.at),
    uniqueIndex('audit_events_seq').on(t.seq),
  ],
);

/**
 * One-time codes for MCP actions (`confirmations.ts` in the engine): issued with a preview, used
 * once by the same caller for the same input, within five minutes.
 */
export const actionConfirmations = sqliteTable(
  'action_confirmations',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id').notNull(),
    tool: text('tool').notNull(),
    /** SHA-256 of the action's input (`fingerprintOf`), so the code runs only what was previewed. */
    inputDigest: text('input_digest').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (t) => [index('action_confirmations_expires').on(t.expiresAt)],
);

/** Model tokens each person's assistant conversations used per UTC day (`usage.ts` in the engine). */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    principalId: text('principal_id').notNull(),
    /** `2026-10-17`. */
    day: text('day').notNull(),
    tokens: integer('tokens').notNull().default(0),
    calls: integer('calls').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.principalId, t.day] }), index('ai_usage_day').on(t.day)],
);

/** AI shopping platforms let in to check out over UCP (`apps/engine/src/ucp/`). */
export const ucpPlatforms = sqliteTable(
  'ucp_platforms',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** The UCP profile the platform must name in `UCP-Agent`. */
    profileUrl: text('profile_url').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    /** SHA-256 of the platform's API key. */
    keyHash: text('key_hash').notNull(),
    /** The profile as last fetched (JSON), and when. */
    profile: text('profile'),
    profileFetchedAt: integer('profile_fetched_at'),
    createdAt: integer('created_at').notNull(),
    createdBy: text('created_by'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [uniqueIndex('ucp_platforms_key').on(t.keyHash)],
);

/** Checkout sessions (`CheckoutSession` in @orderloop/core, as JSON in `data`). */
export const checkoutSessions = sqliteTable(
  'checkout_sessions',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    status: text('status').notNull(),
    data: text('data').notNull(),
    orderId: text('order_id'),
    /** Compared on every write. */
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [
    index('checkout_sessions_owner').on(t.ownerId, t.createdAt),
    index('checkout_sessions_expires').on(t.expiresAt),
    uniqueIndex('checkout_sessions_order').on(t.orderId).where(sql`${t.orderId} IS NOT NULL`),
  ],
);

/** Idempotency-Key replays on the UCP endpoints, per platform; kept 24 hours. */
export const ucpIdempotency = sqliteTable(
  'ucp_idempotency',
  {
    ownerId: text('owner_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** Null while the first request is still running. */
    status: integer('status'),
    response: text('response'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.key] }),
    index('ucp_idempotency_created').on(t.createdAt),
  ],
);

/**
 * Carts the Carts page lists (`packages/core/src/cart.ts`), id `cart_…`. The lines, quote and chat
 * live in each cart's CartAgent, which writes this row when the title or status changes. An
 * external cart (opened by a plugin) carries `pluginId` and `sessionRef`, unique together.
 */
export const carts = sqliteTable(
  'carts',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    customerId: text('customer_id'),
    flowId: text('flow_id').notNull(),
    pluginId: text('plugin_id'),
    sessionRef: text('session_ref'),
    orderId: text('order_id'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [
    index('carts_updated').on(t.updatedAt),
    index('carts_status').on(t.status, t.updatedAt),
    uniqueIndex('carts_session').on(t.pluginId, t.sessionRef).where(sql`${t.pluginId} IS NOT NULL`),
  ],
);

/**
 * Promotion codes the `commerce.discount` node applies. `kind` is `pct` (`value` a percentage),
 * `amount` (`value` off the subtotal) or `free_shipping`; `skus` a JSON array the discount is
 * limited to, or null for every line.
 */
export const promotions = sqliteTable(
  'promotions',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull().default(''),
    kind: text('kind').notNull(),
    value: real('value').notNull().default(0),
    currency: text('currency'),
    minSubtotal: real('min_subtotal'),
    skus: text('skus'),
    customerId: text('customer_id'),
    validFrom: integer('valid_from'),
    validTo: integer('valid_to'),
    maxRedemptions: integer('max_redemptions'),
    perCustomerLimit: integer('per_customer_limit'),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('promotions_code').on(t.code)],
);

/** One per promotion per order, written by the discount node's step, so a retry redeems once. */
export const promotionRedemptions = sqliteTable(
  'promotion_redemptions',
  {
    promotionId: text('promotion_id').notNull(),
    orderId: text('order_id').notNull(),
    customerId: text('customer_id'),
    amount: real('amount').notNull(),
    stepKey: text('step_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.promotionId, t.orderId] }),
    index('promotion_redemptions_customer').on(t.promotionId, t.customerId),
  ],
);
