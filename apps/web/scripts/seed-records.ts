/**
 * Fills the local D1 (and the DOCS bucket) with what the other seeds leave empty, so every page
 * has something on it: a team with a dev admin you sign in as, API tokens, SCIM groups and the
 * workspace's settings; promotions and their redemptions; tax certificates (with their files) on
 * business customers; email intake; an audit history; and, on the `ord_bench_` orders that
 * `pnpm db:seed:volume` wrote, the records the engine would have kept for them (invoices,
 * shipments, stock holds, seller orders and payouts, messages and documents) for Commerce's
 * Records tabs. Local only, like seed-volume. See docs/local-development.md, "Seed everything".
 *
 *   pnpm db:seed:records [--orders 3000] [--seed 1]
 *   pnpm db:seed:records --cleanup
 *
 * Adding people turns sign-in on: the dev admin's email, password and an API token are written to
 * `.secrets/local-dev-login.json` (gitignored), reused on the next run, and two-factor is set to
 * not required. `--cleanup` removes everything it wrote, people included, which turns sign-in off
 * again when no one else was added; audit events stay, since the audit log refuses deletes of
 * events younger than 90 days.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generatePassword, hashPassword, newApiToken, sha256Hex } from '../app/lib/credentials';
import {
  DAY,
  failWith,
  HOUR,
  inserts,
  LOCAL_LOGIN,
  type LocalLogin,
  localEnv,
  MIN,
  q,
  type Rng,
  readLocalLogin,
  rng,
  run,
} from './seed-lib';

const fail: (message: string) => never = failWith('seed-records');

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? fallback : Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v < 1) fail(`--${name} takes a whole number`);
  return v;
}

const ADMIN_ID = 'usr_seed_admin';
const TOKEN_ID = 'tok_seed_dev';

// Every row this writes has an id with `seed` in it, so cleanup removes exactly those.
const CLEANUP = [
  `DELETE FROM promotion_redemptions WHERE promotion_id LIKE 'promo\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM promotions WHERE id LIKE 'promo\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM tax_certificates WHERE id LIKE 'txc\\_seed%' ESCAPE '\\';`,
  `DELETE FROM inbound_emails WHERE id LIKE 'eml\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM invoices WHERE id LIKE 'inv\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM shipments WHERE id LIKE '%\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM reservations WHERE id LIKE 'res\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM seller_orders WHERE id LIKE 'so\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM payouts WHERE id LIKE 'pout\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM messages WHERE id LIKE 'msg\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM documents WHERE id LIKE 'orders/%/seed-%';`,
];
/** People and what hangs off them; kept on a re-run so a signed-in dev admin stays signed in. */
const CLEANUP_PEOPLE = [
  `DELETE FROM scim_group_members WHERE group_id LIKE 'grp\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM scim_groups WHERE id LIKE 'grp\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM api_tokens WHERE id LIKE 'tok\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM sessions WHERE user_id LIKE 'usr\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM users WHERE id LIKE 'usr\\_seed\\_%' ESCAPE '\\';`,
  `DELETE FROM workspace_settings WHERE updated_by = 'seed';`,
];

const TEAM: {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'operator' | 'approver' | 'viewer';
  lastLogin?: number;
  totp?: boolean;
  disabled?: boolean;
  changeDue?: boolean;
  sso?: boolean;
}[] = [
  { id: ADMIN_ID, name: 'Dev Admin', email: 'dev-admin@example.com', role: 'admin', lastLogin: 0 },
  {
    id: 'usr_seed_mara',
    name: 'Mara Okafor',
    email: 'mara@example.com',
    role: 'admin',
    lastLogin: 3 * HOUR,
    totp: true,
  },
  {
    id: 'usr_seed_jun',
    name: 'Jun Park',
    email: 'jun@example.com',
    role: 'operator',
    lastLogin: 20 * MIN,
    totp: true,
  },
  {
    id: 'usr_seed_ines',
    name: 'Inês Duarte',
    email: 'ines@example.com',
    role: 'operator',
    lastLogin: 2 * DAY,
  },
  {
    id: 'usr_seed_tomas',
    name: 'Tomás Rivera',
    email: 'tomas@example.com',
    role: 'approver',
    lastLogin: 5 * HOUR,
    sso: true,
  },
  {
    id: 'usr_seed_priya',
    name: 'Priya Nair',
    email: 'priya@example.com',
    role: 'approver',
    lastLogin: 9 * DAY,
    sso: true,
  },
  {
    id: 'usr_seed_sam',
    name: 'Sam Reyes',
    email: 'sam@example.com',
    role: 'viewer',
    changeDue: true,
  },
  {
    id: 'usr_seed_lee',
    name: 'Lee Whitford',
    email: 'lee@example.com',
    role: 'operator',
    lastLogin: 40 * DAY,
    disabled: true,
  },
];

const PROMOTIONS: [string, string, string, number, Partial<Record<string, unknown>>][] = [
  ['WELCOME10', 'Welcome: 10% off a first order', 'pct', 10, { per_customer_limit: 1 }],
  ['FREESHIP50', 'Free shipping over $50', 'free_shipping', 0, { min_subtotal: 50 }],
  ['SPRING15', 'Spring sale', 'pct', 15, { valid_to: -12 * DAY, status: 'paused' }],
  ['TAKE20', '$20 off orders over $150', 'amount', 20, { currency: 'USD', min_subtotal: 150 }],
  ['VIP25', 'VIP: 25% off', 'pct', 25, { max_redemptions: 200 }],
  ['TEES3', 'Tees: 3 for 2', 'pct', 33, { skus: ['TEE-01'] }],
  ['NORTHWIND5', 'Northwind contract discount', 'pct', 5, { customer_id: 'cus_northwind' }],
  ['HOLIDAY30', 'Holiday preview', 'pct', 30, { valid_from: 20 * DAY, max_redemptions: 500 }],
];

const CARRIERS = ['ups', 'fedex', 'usps', 'dhl'] as const;
const MAILBOXES = ['orders@', 'po@', 'purchasing@'] as const;
const REJECTS = [
  'Sender not recognised',
  'DMARC failed',
  'No order found in the message',
  'Attachment too large',
];

type OrderRow = {
  id: string;
  model: string;
  status: string;
  total: number;
  currency: string;
  customer_id: string | null;
  contact_email: string | null;
  title: string | null;
  flow_id: string;
  created_at: number;
  updated_at: number;
};

async function main() {
  const proxy = await localEnv();
  const { DB: db, DOCS: docs } = proxy.env;
  try {
    if (process.argv.includes('--cleanup')) {
      await run(db, [...CLEANUP, ...CLEANUP_PEOPLE]);
      const left = await db.prepare('select count(*) n from users').first<{ n: number }>();
      console.log(
        `seed-records: removed what it wrote${left?.n ? '' : '; no people left, so sign-in is off once `pnpm web:dev` restarts'}`,
      );
    } else await generate(db, docs);
  } finally {
    await proxy.dispose();
  }
}

async function generate(db: D1Database, docs: R2Bucket) {
  const r = rng(arg('seed', 1));
  const now = Date.now();
  const orders = (
    await db
      .prepare(
        `select id, model, status, total, currency, customer_id, contact_email, title, flow_id, created_at, updated_at
         from orders where id like 'ord\\_bench\\_%' escape '\\' order by created_at desc limit ?`,
      )
      .bind(arg('orders', 3000))
      .all<OrderRow>()
  ).results;
  if (!orders.length)
    console.log('seed-records: no generated orders; run `pnpm db:seed:volume` first for Records');
  const sellers = (await db.prepare('select id from sellers').all<{ id: string }>()).results.map(
    (s) => s.id,
  );
  const locations = (
    await db.prepare('select id from locations').all<{ id: string }>()
  ).results.map((l) => l.id);
  const skus = (
    await db.prepare('select sku, name, price from products limit 400').all<{
      sku: string;
      name: string;
      price: number;
    }>()
  ).results;
  const businesses = (
    await db
      .prepare(
        `select id, name from customers where kind = 'business' order by id like 'cus\\_bench\\_%' escape '\\', id limit 40`,
      )
      .all<{ id: string; name: string }>()
  ).results;

  const login = await people(db, now);
  const statements = [
    ...CLEANUP,
    ...promotions(r, now, orders),
    ...(await certificates(r, now, businesses, docs)),
    ...intake(r, now, orders),
    ...(await records(r, orders, sellers, locations, skus, docs)),
    ...audit(r, now, orders, businesses),
  ];
  await run(db, statements);
  console.log(
    `seed-records: done. Sign in as ${login.email}; the password and an API token are in ${LOCAL_LOGIN}`,
  );
}

/** The team, its tokens and SCIM groups, and settings that keep local sign-in simple. */
async function people(db: D1Database, now: number): Promise<LocalLogin> {
  const kept = readLocalLogin();
  const admin = TEAM[0]!;
  const login: LocalLogin = {
    email: admin.email,
    password: kept?.password ?? generatePassword(),
    token: kept?.token ?? (await newApiToken()).token,
  };
  mkdirSync(dirname(LOCAL_LOGIN), { recursive: true });
  writeFileSync(LOCAL_LOGIN, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });

  const users = await Promise.all(
    TEAM.map(async (u, i) => [
      u.id,
      u.email,
      u.name,
      u.role,
      // Only the dev admin's password is known; the others' are random, never written down.
      u.sso ? null : await hashPassword(u.id === ADMIN_ID ? login.password : generatePassword()),
      u.sso ? `oidc|${u.id.slice(9)}` : null,
      now - (120 - i * 9) * DAY,
      u.lastLogin === undefined ? null : now - u.lastLogin,
      u.disabled ? now - 30 * DAY : null,
      u.totp ? now - 60 * DAY : null,
      u.changeDue ? 1 : 0,
      u.sso ? `ext-${u.id.slice(9)}` : null,
    ]),
  );
  const tokenHash = await sha256Hex(login.token);
  const tokens = [
    [
      TOKEN_ID,
      'Local seed scripts',
      login.token.slice(0, 12),
      tokenHash,
      'admin',
      admin.email,
      ADMIN_ID,
      now - 7 * DAY,
      now,
      null,
      null,
    ],
    [
      'tok_seed_erp',
      'ERP sync',
      'ol_live_Xk2q',
      await sha256Hex(generatePassword()),
      'operator',
      'mara@example.com',
      'usr_seed_mara',
      now - 80 * DAY,
      now - 11 * MIN,
      null,
      null,
    ],
    [
      'tok_seed_bi',
      'BI export (read only)',
      'ol_live_9fRw',
      await sha256Hex(generatePassword()),
      'viewer',
      'mara@example.com',
      'usr_seed_mara',
      now - 50 * DAY,
      now - 2 * DAY,
      null,
      now + 40 * DAY,
    ],
    [
      'tok_seed_old',
      'Old storefront',
      'ol_live_pQ3z',
      await sha256Hex(generatePassword()),
      'operator',
      'jun@example.com',
      'usr_seed_jun',
      now - 200 * DAY,
      now - 95 * DAY,
      now - 90 * DAY,
      null,
    ],
  ];
  const setting = (key: string, value: string) => [key, value, now, 'seed'];
  await run(db, [
    ...inserts(
      'users',
      [
        'id',
        'email',
        'name',
        'role',
        'password_hash',
        'external_sub',
        'created_at',
        'last_login_at',
        'disabled_at',
        'totp_enabled_at',
        'password_change_due',
        'scim_external_id',
      ],
      users,
      'INSERT OR IGNORE',
    ),
    // A kept user keeps its row (and sessions); the dev admin's password and token follow the file.
    `UPDATE users SET password_hash = ${q(users[0]![4])}, disabled_at = NULL WHERE id = '${ADMIN_ID}';`,
    ...inserts(
      'api_tokens',
      [
        'id',
        'name',
        'prefix',
        'token_hash',
        'role',
        'created_by',
        'created_by_id',
        'created_at',
        'last_used_at',
        'revoked_at',
        'expires_at',
      ],
      tokens,
      'INSERT OR IGNORE',
    ),
    `UPDATE api_tokens SET token_hash = ${q(tokenHash)}, prefix = ${q(login.token.slice(0, 12))}, revoked_at = NULL WHERE id = '${TOKEN_ID}';`,
    ...inserts(
      'scim_groups',
      ['id', 'display_name', 'external_id', 'created_at', 'updated_at'],
      [
        ['grp_seed_ops', 'Order operations', 'okta-00g1ops', now - 60 * DAY, now - 3 * DAY],
        ['grp_seed_fin', 'Finance approvers', 'okta-00g2fin', now - 60 * DAY, now - 9 * DAY],
      ],
      'INSERT OR IGNORE',
    ),
    ...inserts(
      'scim_group_members',
      ['group_id', 'user_id'],
      [
        ['grp_seed_fin', 'usr_seed_tomas'],
        ['grp_seed_fin', 'usr_seed_priya'],
        ['grp_seed_ops', 'usr_seed_tomas'],
      ],
      'INSERT OR IGNORE',
    ),
    // Two-factor off, so the dev admin isn't sent to set it up; replaced on every run.
    ...inserts(
      'workspace_settings',
      ['key', 'value', 'updated_at', 'updated_by'],
      [
        setting('two_factor_required', 'off'),
        setting('approval_separation', 'on'),
        setting(
          'scim_roles',
          JSON.stringify({ grp_seed_ops: 'operator', grp_seed_fin: 'approver' }),
        ),
        setting('scim_token', await sha256Hex(generatePassword())),
      ],
      'INSERT OR REPLACE',
    ),
  ]);
  return login;
}

function promotions(r: Rng, now: number, orders: OrderRow[]): string[] {
  const rows = PROMOTIONS.map(([code, name, kind, value, o], i) => [
    `promo_seed_${code.toLowerCase()}`,
    code,
    name,
    kind,
    value,
    o.currency ?? null,
    o.min_subtotal ?? null,
    o.skus ? JSON.stringify(o.skus) : null,
    o.customer_id ?? null,
    o.valid_from ? now + Number(o.valid_from) : now - (90 - i * 7) * DAY,
    o.valid_to ? now + Number(o.valid_to) : null,
    o.max_redemptions ?? null,
    o.per_customer_limit ?? null,
    o.status ?? 'active',
    'mara@example.com',
    now - (90 - i * 7) * DAY,
    now - i * DAY,
  ]);
  // Redemptions on consumer orders that completed while each was live.
  const redemptions: unknown[][] = [];
  const seen = new Set<string>();
  for (const o of orders) {
    if (o.status !== 'completed' || o.model === 'b2b' || !r.chance(0.18)) continue;
    const p = r.pick(rows.filter((x) => x[13] === 'active' || x[1] === 'SPRING15'));
    if ((p[9] as number) > o.created_at || seen.has(`${p[0]}|${o.id}`)) continue;
    seen.add(`${p[0]}|${o.id}`);
    const amount =
      p[3] === 'pct'
        ? Math.round(o.total * (p[4] as number)) / 100
        : p[3] === 'amount'
          ? (p[4] as number)
          : 8.95;
    redemptions.push([p[0], o.id, o.customer_id, amount, 'price#1', o.created_at + MIN]);
  }
  return [
    ...inserts(
      'promotions',
      [
        'id',
        'code',
        'name',
        'kind',
        'value',
        'currency',
        'min_subtotal',
        'skus',
        'customer_id',
        'valid_from',
        'valid_to',
        'max_redemptions',
        'per_customer_limit',
        'status',
        'created_by',
        'created_at',
        'updated_at',
      ],
      rows,
    ),
    ...inserts(
      'promotion_redemptions',
      ['promotion_id', 'order_id', 'customer_id', 'amount', 'step_key', 'created_at'],
      redemptions,
    ),
  ];
}

/** A one-page PDF that says what it is, for certificate downloads. */
function pdf(text: string): Uint8Array {
  const body = `BT /F1 14 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function certificates(
  r: Rng,
  now: number,
  businesses: { id: string; name: string }[],
  docs: R2Bucket,
): Promise<string[]> {
  const STATES = ['CA', 'NY', 'TX', 'WA', 'IL', 'FL'];
  const rows: unknown[][] = [];
  for (const [i, c] of businesses.slice(0, 14).entries()) {
    const id = `txc_seed${String(i).padStart(2, '0')}`;
    const region = r.pick(STATES);
    const state = i % 7 === 3 ? 'revoked' : 'active';
    const withFile = i % 3 !== 2;
    const key = `customers/${c.id}/tax-certificates/${id}`;
    if (withFile) {
      const file = pdf(`Resale certificate ${region}-${100000 + i * 7919} for ${c.name}`);
      await docs.put(key, file, { httpMetadata: { contentType: 'application/pdf' } });
      rows.push([
        id,
        c.id,
        `${region}-${100000 + i * 7919}`,
        JSON.stringify([{ country: 'US', region }]),
        i % 4 === 1 ? now - 5 * DAY : now + r.int(30, 700) * DAY,
        key,
        `resale-${region.toLowerCase()}.pdf`,
        'application/pdf',
        file.byteLength,
        state,
      ]);
    } else
      rows.push([
        id,
        c.id,
        `EX-${2000 + i}`,
        JSON.stringify([{ country: 'US' }]),
        null,
        null,
        null,
        null,
        null,
        state,
      ]);
    const at = now - r.int(20, 300) * DAY;
    const row = rows.at(-1)!;
    row.push(
      'ines@example.com',
      'usr_seed_ines',
      at,
      i % 2 ? 'mara@example.com' : null,
      i % 2 ? at + DAY : null,
      state === 'revoked' ? 'mara@example.com' : null,
      state === 'revoked' ? now - 10 * DAY : null,
    );
  }
  return inserts(
    'tax_certificates',
    [
      'id',
      'customer_id',
      'number',
      'regions',
      'expires_at',
      'file_key',
      'file_name',
      'file_type',
      'file_size',
      'status',
      'created_by',
      'created_by_id',
      'created_at',
      'verified_by',
      'verified_at',
      'revoked_by',
      'revoked_at',
    ],
    rows,
  );
}

/** Email intake: orders read from mail, a few duplicates and refusals. */
function intake(r: Rng, now: number, orders: OrderRow[]): string[] {
  const business = orders.filter((o) => ['b2b', 'procurement', 'replenishment'].includes(o.model));
  const rows: unknown[][] = [];
  for (let i = 0; i < 60; i++) {
    const at = now - Math.floor(r.next() * 30 * DAY);
    const status = r.weighted([
      ['accepted', 78],
      ['duplicate', 8],
      ['rejected', 14],
    ] as const);
    const order = status === 'accepted' && business.length ? r.pick(business) : null;
    rows.push([
      `eml_seed_${i.toString(36).padStart(3, '0')}`,
      `<seed-${i}.${at}@mail.example>`,
      `${r.pick(MAILBOXES)}orderloop.local`,
      r.pick([
        'ap@contoso.example',
        'orders@fabrikam.example',
        'purchasing@northwind.example',
        'buyer@initech.example',
        'noreply@unknown.example',
      ]),
      order
        ? `PO ${10000 + i}: ${order.title ?? 'replenishment'}`
        : r.pick(['Re: quote', 'Purchase order attached', 'Invoice query', 'Order']),
      status,
      status === 'rejected' ? r.pick(REJECTS) : status === 'duplicate' ? 'Already received' : null,
      order?.id ?? null,
      null,
      status === 'accepted' ? r.int(1, 2) : r.int(0, 1),
      at,
    ]);
  }
  return inserts(
    'inbound_emails',
    [
      'id',
      'message_id',
      'mailbox',
      'sender',
      'subject',
      'status',
      'reason',
      'order_id',
      'r2_key',
      'attachments',
      'received_at',
    ],
    rows,
  );
}

const html = (title: string, o: OrderRow, extra: Record<string, string>) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;margin:40px"><h1>${title}</h1><dl>${Object.entries(
    { Order: o.id, Total: `${o.total.toFixed(2)} ${o.currency}`, ...extra },
  )
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')}</dl></body>`;

/** What the engine would have recorded for the generated orders, by flow and how each ended. */
async function records(
  r: Rng,
  orders: OrderRow[],
  sellers: string[],
  locations: string[],
  skus: { sku: string; name: string; price: number }[],
  docs: R2Bucket,
): Promise<string[]> {
  const invoices: unknown[][] = [];
  const shipments: unknown[][] = [];
  const holds: unknown[][] = [];
  const sellerOrders: unknown[][] = [];
  const payouts: unknown[][] = [];
  const messages: unknown[][] = [];
  const documents: unknown[][] = [];
  const puts: Promise<unknown>[] = [];
  let docCount = 0;
  const open = (s: string) => ['waiting', 'running', 'queued'].includes(s);
  const stopped = (s: string) => ['failed', 'rolled_back', 'cancelled', 'declined'].includes(s);
  for (const o of orders) {
    const t = o.created_at;
    const done = o.status === 'completed';
    const physical = o.flow_id !== 'tpl-subscription';
    const lines =
      physical && skus.length ? [r.pick(skus), ...(r.chance(0.4) ? [r.pick(skus)] : [])] : [];
    for (const [i, l] of lines.entries())
      holds.push([
        `res_seed_${o.id}_${i}`,
        o.id,
        l.sku,
        r.int(1, o.model === 'b2b' ? 40 : 3),
        open(o.status) ? 'held' : done ? 'consumed' : 'released',
        t + MIN,
        o.flow_id === 'tpl-omnichannel-order' && locations.length ? r.pick(locations) : null,
      ]);
    if (physical && (done || (open(o.status) && r.chance(0.3))) && o.flow_id !== 'tpl-pos-sale') {
      const pickup = o.flow_id === 'tpl-omnichannel-order' && r.chance(0.4);
      const carrier = pickup ? 'pickup' : r.pick(CARRIERS);
      shipments.push([
        `${pickup ? 'pkp' : 'shp'}_seed_${o.id}`,
        o.id,
        carrier,
        pickup
          ? `PICKUP-${o.id.slice(-5).toUpperCase()}`
          : `${carrier.toUpperCase()}${r.int(1e9, 9e9)}`,
        pickup ? (done ? 'collected' : 'ready_for_pickup') : 'label_created',
        t + r.int(2, 30) * HOUR,
      ]);
      if (done && r.chance(0.05))
        shipments.push([
          `rma_seed_${o.id}`,
          o.id,
          carrier,
          `RMA${r.int(1e7, 9e7)}`,
          'return_label',
          o.updated_at + 2 * DAY,
        ]);
    }
    if (['tpl-b2b-order', 'tpl-purchase-request', 'tpl-reorder'].includes(o.flow_id)) {
      const terms = r.pick(['net_30', 'net_30', 'net_15', 'due_on_receipt']);
      const status = done ? (r.chance(0.8) ? 'paid' : 'open') : stopped(o.status) ? 'void' : 'open';
      const id = `inv_seed_${o.id}`;
      invoices.push([
        id,
        o.id,
        'mock',
        status,
        null,
        `INV-${String(40000 + invoices.length)}`,
        null,
        o.total,
        o.currency,
        terms,
        t + 30 * DAY,
        null,
        t + HOUR,
        status === 'paid' ? t + r.int(5, 40) * DAY : null,
      ]);
      if (docCount < 600) {
        const kind = o.flow_id === 'tpl-b2b-order' ? 'invoice' : 'po';
        const key = `orders/${o.id}/${kind}/seed-1.html`;
        puts.push(
          docs.put(
            key,
            html(`${kind === 'po' ? 'Purchase order' : 'Invoice'} ${o.id}`, o, { Terms: terms }),
            { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
          ),
        );
        documents.push([key, o.id, kind, key, 'text/html; charset=utf-8', t + HOUR]);
        docCount++;
      }
    }
    if (o.flow_id === 'tpl-marketplace-order' && sellers.length) {
      const picked = [...new Set([r.pick(sellers), r.pick(sellers)])];
      for (const s of picked) {
        const subtotal = Math.round((o.total / picked.length) * 100) / 100;
        const status = done
          ? 'accepted'
          : stopped(o.status)
            ? r.pick(['rejected', 'cancelled'])
            : r.pick(['pending', 'accepted']);
        sellerOrders.push([
          `so_seed_${o.id}_${s}`,
          o.id,
          s,
          status,
          JSON.stringify(
            lines.map((l) => ({
              sku: l.sku,
              name: l.name,
              qty: 1,
              unitPrice: l.price,
              sellerId: s,
            })),
          ),
          subtotal,
          status === 'rejected' ? 'Out of stock at the seller' : null,
          t + MIN,
          status === 'pending' ? null : t + r.int(10, 300) * MIN,
        ]);
        if (status === 'accepted') {
          const commission = Math.round(subtotal * 12) / 100;
          const reversed = done && r.chance(0.04);
          payouts.push([
            `pout_seed_${o.id}_${s}`,
            o.id,
            s,
            subtotal,
            commission,
            reversed ? subtotal : 0,
            reversed ? 0 : subtotal - commission,
            reversed
              ? 'reversed'
              : done && o.updated_at < Date.now() - 7 * DAY
                ? 'paid'
                : 'scheduled',
            t + HOUR,
          ]);
        }
      }
    }
    const to = o.contact_email ?? 'buyer@example.com';
    if (done || open(o.status))
      messages.push([
        `msg_seed_${o.id}_1`,
        o.id,
        to,
        `We have your order ${o.id.slice(-6)}`,
        `Thanks for your order of ${o.total.toFixed(2)} ${o.currency}. We'll write again when it ships.`,
        t + MIN,
      ]);
    if (done && physical)
      messages.push([
        `msg_seed_${o.id}_2`,
        o.id,
        to,
        'Your order is on its way',
        'Track it with the link in your account.',
        t + r.int(4, 48) * HOUR,
      ]);
    if (stopped(o.status))
      messages.push([
        `msg_seed_${o.id}_3`,
        o.id,
        to,
        'About your order',
        'We could not complete your order. Nothing has been charged.',
        o.updated_at,
      ]);
  }
  await Promise.all(puts);
  return [
    ...inserts(
      'invoices',
      [
        'id',
        'order_id',
        'provider',
        'status',
        'external_id',
        'number',
        'hosted_url',
        'amount',
        'currency',
        'terms',
        'due_at',
        'balance_entry_id',
        'created_at',
        'paid_at',
      ],
      invoices,
    ),
    ...inserts(
      'shipments',
      ['id', 'order_id', 'carrier', 'tracking', 'status', 'created_at'],
      shipments,
    ),
    ...inserts(
      'reservations',
      ['id', 'order_id', 'sku', 'qty', 'status', 'created_at', 'location_id'],
      holds,
    ),
    ...inserts(
      'seller_orders',
      [
        'id',
        'order_id',
        'seller_id',
        'status',
        'lines',
        'subtotal',
        'reason',
        'created_at',
        'decided_at',
      ],
      sellerOrders,
    ),
    ...inserts(
      'payouts',
      [
        'id',
        'order_id',
        'seller_id',
        'gross',
        'commission',
        'refunded',
        'net',
        'status',
        'created_at',
      ],
      payouts,
    ),
    ...inserts(
      'messages',
      ['id', 'order_id', 'recipient', 'subject', 'body', 'created_at'],
      messages,
    ),
    ...inserts(
      'documents',
      ['id', 'order_id', 'kind', 'r2_key', 'content_type', 'created_at'],
      documents,
    ),
  ];
}

/**
 * Three months of what the team did. Pre-chain rows (no seq or hash), so the live hash chain is
 * untouched; fixed ids, so a re-run adds nothing.
 */
function audit(
  r: Rng,
  now: number,
  orders: OrderRow[],
  businesses: { id: string; name: string }[],
): string[] {
  const staff = TEAM.filter((u) => !u.disabled);
  const actions: [
    string,
    number,
    (u: (typeof TEAM)[number]) => [string | null, Record<string, unknown>],
  ][] = [
    ['auth.sign_in', 30, (u) => [null, u.sso ? { method: 'sso' } : {}]],
    ['auth.sign_in_failed', 4, () => [null, { reason: 'wrong password' }]],
    ['auth.sign_out', 6, () => [null, {}]],
    [
      'order.started',
      14,
      () => [orders.length ? r.pick(orders).id : null, { via: r.pick(['app', 'api']) }],
    ],
    [
      'approval.decided',
      12,
      () => [
        orders.length ? r.pick(orders).id : null,
        { decision: r.pick(['approved', 'approved', 'declined']), via: 'app' },
      ],
    ],
    [
      'order.cancelled',
      2,
      () => [orders.length ? r.pick(orders).id : null, { reason: 'Customer asked', via: 'app' }],
    ],
    [
      'flow.saved',
      5,
      () => [
        r.pick(['tpl-storefront-order', 'tpl-b2b-order', 'tpl-marketplace-order']),
        { via: 'app' },
      ],
    ],
    [
      'flow.published',
      3,
      () => [
        r.pick(['tpl-storefront-order', 'tpl-b2b-order']),
        { version: r.int(2, 6), via: 'app' },
      ],
    ],
    ['promotion.saved', 3, () => [r.pick(PROMOTIONS)[0], { via: 'app' }]],
    [
      'tax_certificate.added',
      2,
      () => [businesses.length ? r.pick(businesses).id : null, { via: 'app' }],
    ],
    [
      'tax_certificate.verified',
      2,
      () => [businesses.length ? r.pick(businesses).id : null, { via: 'app' }],
    ],
    ['cart.created', 4, () => [`cart_${r.int(1e5, 9e5)}`, { via: 'app' }]],
    ['stock.review_run', 2, () => [null, { via: 'app' }]],
    [
      'catalog.edits_published',
      3,
      () => [null, { published: r.int(1, 30), failed: 0, via: 'app' }],
    ],
    ['token.created', 1, () => ['ERP sync', { role: 'operator' }]],
    ['team.role_changed', 1, () => ['ines@example.com', { from: 'approver', to: 'operator' }]],
    ['team.user_added', 1, () => ['sam@example.com', { role: 'viewer' }]],
    ['team.user_disabled', 1, () => ['lee@example.com', { sessions: 2, apps: 0, tokens: 1 }]],
    ['team.approval_separation', 1, () => [null, { from: 'off', to: 'on' }]],
  ];
  const rows: unknown[][] = [];
  for (let i = 0; i < 400; i++) {
    const [action, , detail] = r.weighted(actions.map((a) => [a, a[1]] as const));
    const u = action.startsWith('team.') || action === 'token.created' ? TEAM[1]! : r.pick(staff);
    const [target, d] = detail(u);
    const at = now - 90 * DAY + Math.floor((i / 400) * 90 * DAY) + r.int(0, HOUR);
    rows.push([
      `aud_seed_${String(i).padStart(4, '0')}`,
      at,
      action,
      u.email,
      u.id,
      'user',
      target,
      JSON.stringify(d),
      `203.0.113.${r.int(2, 250)}`,
    ]);
  }
  return inserts(
    'audit_events',
    ['id', 'at', 'action', 'actor', 'actor_id', 'actor_kind', 'target', 'detail', 'ip'],
    rows,
    'INSERT OR IGNORE',
  );
}

await main();
