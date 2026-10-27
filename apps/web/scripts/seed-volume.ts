/**
 * Fills the local D1 with a large, realistic order history, so the overview, the orders list,
 * approvals and the Performance page can be checked at volume before a workspace has real data.
 * Local only: it opens apps/web's local D1 through wrangler's platform proxy, with a config that
 * binds nothing else. See docs/local-development.md, "Volume data".
 *
 *   pnpm db:seed:volume [--orders 20000] [--days 90] [--seed 1]
 *   pnpm db:seed:volume --cleanup
 *
 * Orders go on the built-in flows (published here as the app does on first use), with steps,
 * waits, failures and reasons taken from each flow's own nodes: open orders wait at an approval
 * (with a pending approval), an event or a timer; ended ones completed, failed, rolled back, were
 * declined or cancelled, spread over the window with a weekly rhythm and some growth. Each gets
 * its payments (captures, charges and some refunds), approvals already decided, and a timing row
 * per step it ran (`node_runs`), so every overview and Performance figure has something to count.
 *
 * Only the orders index is written: there is no OrderAgent or Workflow behind these orders, so an
 * order's own page has no timeline or graph. Every row it writes has an id starting `ord_bench_`
 * (orders), `pay_bench_`, `apr_bench_` or `cus_bench_`, in channel `bench`, and `--cleanup`
 * deletes exactly those. The same `--seed` gives the same data relative to today.
 */

import { type Flow, TEMPLATES } from '@orderloop/core';
import { createDb, seedFlows } from '@orderloop/db';
import { DAY, failWith, HOUR, inserts, localEnv, MIN, rng, run } from './seed-lib';

/** Days of orders before the window, so it opens in a steady state. */
const LEAD_IN_DAYS = 30;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? fallback : Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v < 1) fail(`--${name} takes a whole number`);
  return v;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

const fail: (message: string) => never = failWith('seed-volume');

const CLEANUP = [
  `DELETE FROM node_runs WHERE order_id LIKE 'ord\\_bench\\_%' ESCAPE '\\';`,
  `DELETE FROM payments WHERE id LIKE 'pay\\_bench\\_%' ESCAPE '\\';`,
  `DELETE FROM approvals WHERE id LIKE 'apr\\_bench\\_%' ESCAPE '\\';`,
  `DELETE FROM orders WHERE id LIKE 'ord\\_bench\\_%' ESCAPE '\\';`,
  `DELETE FROM carts WHERE id LIKE 'cart\\_bench\\_%' ESCAPE '\\';`,
  `DELETE FROM price_rules WHERE id LIKE 'pr\\_bench\\_%' ESCAPE '\\';`,
  `DELETE FROM contract_prices WHERE sku LIKE 'BENCH-%';`,
  `DELETE FROM location_stock WHERE sku LIKE 'BENCH-%';`,
  `DELETE FROM products WHERE sku LIKE 'BENCH-%';`,
  `DELETE FROM customers WHERE id LIKE 'cus\\_bench\\_%' ESCAPE '\\';`,
];

/** What a run can fill; customers come with every run, since the rest refer to them. */
const SECTIONS = ['products', 'orders', 'carts'] as const;

// How much of the volume each built-in flow carries, and what its orders are worth (USD).
const MIX: Record<string, { weight: number; total: [number, number]; ends: [number, number] }> = {
  'tpl-storefront-order': { weight: 34, total: [25, 420], ends: [2 * HOUR, 5 * DAY] },
  'tpl-marketplace-order': { weight: 15, total: [30, 650], ends: [6 * HOUR, 6 * DAY] },
  'tpl-omnichannel-order': { weight: 12, total: [40, 900], ends: [HOUR, 4 * DAY] },
  'tpl-pos-sale': { weight: 10, total: [8, 260], ends: [MIN, 20 * MIN] },
  'tpl-b2b-order': { weight: 12, total: [400, 18_000], ends: [DAY, 35 * DAY] },
  'tpl-subscription': { weight: 9, total: [29, 120], ends: [30 * MIN, 2 * DAY] },
  'tpl-purchase-request': { weight: 5, total: [150, 24_000], ends: [DAY, 25 * DAY] },
  'tpl-reorder': { weight: 3, total: [800, 30_000], ends: [2 * DAY, 18 * DAY] },
};

// What goes wrong at a step, by node type: the reason the index shows.
const FAILS: Record<string, string[]> = {
  'commerce.authorize_payment': [
    'Card declined: insufficient funds',
    'Card declined: do not honor',
    '3-D Secure not completed',
  ],
  'commerce.capture_payment': ['Authorization expired before capture'],
  'commerce.charge': ['Card declined: expired card', 'Card declined: insufficient funds'],
  'commerce.reserve_inventory': ['Insufficient stock', 'Insufficient stock at every location'],
  'commerce.ship': ['Carrier API timed out', 'Address could not be validated'],
  'commerce.erp_sync': ['ERP rejected the posting: unknown cost center', 'ERP unavailable (503)'],
  'commerce.credit_check': ['Over the credit limit'],
  'commerce.validate': ['Unknown SKU on line 2', 'Missing shipping address'],
  'commerce.tax': ['Tax service timed out'],
  'commerce.split_by_seller': ['Seller account suspended'],
  'commerce.three_way_match': ['Invoice and receipt quantities differ'],
  'commerce.pay_supplier': ['Supplier bank details rejected'],
  'ai.extract': ['Could not read the purchase order'],
};

// How long a step runs, by node type (median ms); waits are long and spread wide.
function stepMs(type: string, r: ReturnType<typeof rng>): number {
  if (type === 'control.approval') return r.around(3 * HOUR, 1.1);
  if (type === 'control.wait_event') return r.around(20 * HOUR, 1.2);
  if (type === 'control.wait') return r.around(DAY, 0.6);
  if (type.startsWith('ai.')) return r.around(1_800, 0.5);
  if (type === 'commerce.erp_sync' || type === 'commerce.ship') return r.around(900, 0.7);
  if (type.startsWith('commerce.')) return r.around(180, 0.7);
  return r.around(15, 0.5);
}

const FIRST = [
  'Ada',
  'Grace',
  'Alan',
  'Linus',
  'Margaret',
  'Ken',
  'Barbara',
  'Dennis',
  'Frances',
  'Edsger',
  'Radia',
  'Tim',
  'Hedy',
  'Donald',
  'Katherine',
  'John',
  'Sophie',
  'Niklaus',
  'Joan',
  'Guido',
];
const LAST = [
  'Hopper',
  'Turing',
  'Torvalds',
  'Hamilton',
  'Thompson',
  'Liskov',
  'Ritchie',
  'Allen',
  'Dijkstra',
  'Perlman',
  'Berners-Lee',
  'Lamarr',
  'Knuth',
  'Johnson',
  'Backus',
  'Wilson',
  'Wirth',
  'Clarke',
  'van Rossum',
  'Lovelace',
];
const COMPANIES = [
  'Acme Industrial',
  'Globex',
  'Initech',
  'Umbrella Supply',
  'Stark Fabrication',
  'Wayne Logistics',
  'Hooli',
  'Vandelay Imports',
  'Soylent Foods',
  'Tyrell Systems',
  'Cyberdyne Parts',
  'Wonka Confectionery',
  'Gringotts Office',
  'Pied Piper',
  'Oscorp Labs',
  'Massive Dynamic',
  'Aperture Science',
  'Black Mesa',
  'Monarch Tools',
  'Prestige Worldwide',
];
const CURRENCIES: readonly (readonly [string, number])[] = [
  ['USD', 82],
  ['EUR', 10],
  ['GBP', 5],
  ['CAD', 3],
];
const FX: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.37 };

const PRODUCT_KINDS: readonly (readonly [string, number, number, string])[] = [
  ['bearing', 1.5, 40, 'Seal Partners'],
  ['gasket kit', 4, 60, 'Seal Partners'],
  ['widget', 8, 120, 'Acme Supply Co.'],
  ['servo motor', 180, 1_400, 'Volt Motion'],
  ['monitor', 140, 900, 'Tech Distribution'],
  ['laptop', 600, 2_800, 'Tech Distribution'],
  ['cable', 3, 45, 'Tech Distribution'],
  ['tee', 14, 48, 'Loom Works'],
  ['hoodie', 38, 110, 'Loom Works'],
  ['kettle', 29, 160, 'Kettle & Co'],
  ['coffee', 9, 38, 'Roastery Co.'],
  ['safety glove', 4, 30, 'Guardline'],
];
const ADJECTIVES = [
  'Heavy-duty',
  'Compact',
  'Pro',
  'Classic',
  'Industrial',
  'Eco',
  'Premium',
  'Standard',
  'Light',
  'Precision',
];
const CART_TITLES = [
  'Q4 restock',
  'New hire kits',
  'Store refit',
  'Weekly order',
  'Trade show',
  'Office move',
  'Spares',
  'Holiday stock',
  'Sample order',
  'Line 3 maintenance',
];

const BUSINESS_MODELS = new Set(['b2b', 'procurement', 'replenishment']);

type FlowRow = { id: string; name: string; published_version: number | null };

async function main() {
  const proxy = await localEnv();
  const db = proxy.env.DB;
  try {
    if (process.argv.includes('--cleanup')) {
      await run(db, CLEANUP);
      console.log(
        'seed-volume: removed every bench order, payment, approval, product, cart and customer',
      );
    } else await generate(db);
  } finally {
    await proxy.dispose();
  }
}

async function generate(db: D1Database) {
  const total = arg('orders', 20_000);
  const days = arg('days', 90);
  const r = rng(arg('seed', 1));
  const now = Date.now();
  const only = new Set((flag('only') ?? SECTIONS.join(',')).split(','));
  for (const s of only)
    if (!(SECTIONS as readonly string[]).includes(s))
      fail(`--only takes some of ${SECTIONS.join(', ')}, not "${s}"`);

  // The built-in flows, published as the app does on first use (a no-op once they are).
  await seedFlows(
    createDb(db),
    Object.values(TEMPLATES).map((t) => t()),
  );
  const live = new Map(
    (
      await db
        .prepare('select id, name, published_version from flows where archived_at is null')
        .all<FlowRow>()
    ).results.map((f) => [f.id, f]),
  );
  const flows = Object.values(TEMPLATES)
    .map((t) => t() as Flow)
    .filter((f) => MIX[f.id] && live.get(f.id)?.published_version);
  if (!flows.length)
    fail('no built-in flows in the local database. Run `pnpm db:migrate:local` first.');

  // Customers: a pool of people and companies, so lists and names look lived in.
  const people = Array.from({ length: 240 }, (_, i) => {
    const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
    return [
      `cus_bench_p${i}`,
      name,
      `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@example.com`,
      'consumer',
      'consumer',
      0,
      0,
      'due_on_receipt',
    ];
  });
  const companies = COMPANIES.map((name, i) => [
    `cus_bench_c${i}`,
    name,
    `orders@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
    'business',
    r.pick(['standard', 'silver', 'gold']),
    r.pick([25_000, 50_000, 100_000, 250_000]),
    0,
    r.pick(['net_15', 'net_30', 'net_45']),
  ]);

  // Products: a wide back-office catalog with stock at the warehouse and both stores, contract
  // prices for some companies and volume breaks, so Commerce shows a catalog at real size.
  const productRows: unknown[][] = [];
  const stockRows: unknown[][] = [];
  const contractRows: unknown[][] = [];
  const ruleRows: unknown[][] = [];
  if (only.has('products'))
    for (let i = 0; i < arg('products', 2_000); i++) {
      const [noun, lo, hi, supplier] = r.pick(PRODUCT_KINDS);
      const sku = `BENCH-${String(i).padStart(5, '0')}`;
      const price = Math.round((lo + r.next() ** 1.8 * (hi - lo)) * 100) / 100;
      const reorderPoint = r.int(0, 4) * 50;
      const stock = r.chance(0.04) ? 0 : r.int(0, 30) * r.pick([1, 10, 100]);
      productRows.push([
        sku,
        `${r.pick(ADJECTIVES)} ${noun} ${String.fromCharCode(65 + (i % 26))}${r.int(10, 99)}`,
        price,
        Math.round(price * (0.35 + r.next() * 0.3) * 100) / 100,
        stock,
        r.chance(0.2) ? r.int(0, Math.min(stock, 40)) : 0,
        reorderPoint,
        reorderPoint * 3,
        supplier,
        null,
        'physical',
      ]);
      for (const loc of ['loc_mission', 'loc_soho'])
        if (r.chance(0.3)) stockRows.push([loc, sku, r.int(0, 40), 0]);
      if (r.chance(0.08))
        contractRows.push([r.pick(companies)[0], sku, Math.round(price * 0.88 * 100) / 100]);
      if (r.chance(0.05))
        ruleRows.push([
          `pr_bench_${i}`,
          'volume',
          `${noun}, 100+`,
          sku,
          null,
          null,
          100,
          null,
          r.pick([5, 8, 10, 12]),
          null,
          null,
          now,
        ]);
    }

  const orderRows: unknown[][] = [];
  const paymentRows: unknown[][] = [];
  const approvalRows: unknown[][] = [];
  const runRows: unknown[][] = [];
  const counts: Record<string, number> = {};

  // Orders start more on weekdays and in working hours, and the business grows ~40% over the window.
  // They start from a month before it, so its first days already have long orders ending in them.
  const start = now - (days + LEAD_IN_DAYS) * DAY;
  const created = () => {
    for (;;) {
      const t = start + r.next() * (now - start);
      const d = new Date(t);
      const weekday = d.getUTCDay() % 6 === 0 ? 0.55 : 1;
      const hour = d.getUTCHours();
      const daytime = hour >= 13 && hour <= 23 ? 1 : 0.35;
      const growth = 0.7 + 0.3 * ((t - start) / (now - start));
      if (r.next() < weekday * daytime * growth) return Math.floor(t);
    }
  };

  for (let i = 0; only.has('orders') && i < total; i++) {
    const flow = r.weighted(flows.map((f) => [f, MIX[f.id]!.weight] as const));
    const mix = MIX[flow.id]!;
    const version = live.get(flow.id)!.published_version!;
    const business = BUSINESS_MODELS.has(flow.model);
    const customer = business ? r.pick(companies) : r.pick(people);
    const currency = business ? 'USD' : r.weighted(CURRENCIES);
    const fx = FX[currency]!;
    const usd =
      Math.round((mix.total[0] + r.next() ** 2.2 * (mix.total[1] - mix.total[0])) * 100) / 100;
    const amount = Math.round(usd * fx * 100) / 100;
    const createdAt = created();
    const id = `ord_bench_${i.toString(36).padStart(5, '0')}${r.int(0, 1295).toString(36).padStart(2, '0')}`;
    const steps = [...(flow.nodes as Flow['nodes'])]
      .filter((n) => n.type !== 'control.end' && !n.type.startsWith('trigger.'))
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
    const waits = steps.filter((n) =>
      ['control.approval', 'control.wait_event', 'control.wait'].includes(n.type),
    );
    const failable = steps.filter((n) => FAILS[n.type]);
    const approvalsInFlow = steps.filter((n) => n.type === 'control.approval');
    const title = business
      ? flow.model === 'b2b'
        ? `PO ${(customer[1] as string).slice(0, 2).toUpperCase()}-${r.int(1000, 9999)}`
        : flow.model === 'procurement'
          ? r.pick([
              'Laptops for new hires',
              'Office chairs',
              'Trade show booth',
              'Server rack',
              'Safety equipment',
              'Software licences',
            ])
          : `Replenishment ${r.pick(['BRG-608', 'WID-100', 'GSK-010', 'MTR-750', 'LAP-14'])}`
      : flow.model === 'subscription'
        ? r.pick(['Monthly coffee box', 'Quarterly filters', 'Weekly produce box'])
        : `Order ${10_000 + i}`;

    // Where it is now: recent orders may still be open; older ones have ended.
    const age = now - createdAt;
    // When it ends, if it has: an order whose end is still to come is open now.
    const endsAt = createdAt + Math.floor(mix.ends[0] + r.next() * (mix.ends[1] - mix.ends[0]));
    const open = endsAt > now;
    let status: string;
    let updatedAt: number;
    let waitingAt: string | null = null;
    let waitingOn: string | null = null;
    let waitingFor: string | null = null;
    let waitingSince: number | null = null;
    let stoppedAt: string | null = null;
    let reason: string | null = null;
    let stopIndex = steps.length; // steps that ran, for node_runs

    if (open && waits.length && r.chance(0.85)) {
      const w = r.pick(waits);
      status = 'waiting';
      waitingAt = w.label;
      waitingSince = createdAt + Math.floor(r.next() * Math.min(age, HOUR * 6));
      // A share of waits have been sitting for over a day, so the overview has stale ones to show.
      if (r.chance(0.2) && age > DAY) waitingSince = createdAt + Math.floor(r.next() * (age - DAY));
      updatedAt = waitingSince;
      const cfg = (w.config ?? {}) as Record<string, unknown>;
      if (w.type === 'control.approval') {
        waitingFor = `person:${String(cfg.assignee ?? '')}`;
        waitingOn = `${w.label} for ${title}`;
        approvalRows.push([
          `apr_bench_${id.slice(10)}`,
          id,
          w.id,
          `approval-${w.id}`,
          waitingOn,
          String(cfg.assignee ?? ''),
          amount,
          'pending',
          null,
          waitingSince,
          null,
          null,
        ]);
      } else if (w.type === 'control.wait_event') {
        waitingFor = `event:${String(cfg.event ?? '')}`;
        waitingOn = `Waiting for ${String(cfg.event ?? '')}`;
      } else {
        waitingFor = 'timer';
      }
      stopIndex = steps.indexOf(w);
    } else if (open) {
      status = r.chance(0.7) ? 'running' : 'queued';
      updatedAt = createdAt + Math.floor(r.next() * Math.min(age, 10 * MIN));
      stopIndex = Math.floor(steps.length / 3);
    } else {
      status = r.weighted([
        ['completed', 84],
        ['failed', 4.5],
        ['rolled_back', 2.5],
        ['declined', approvalsInFlow.length ? 4 : 0.5],
        ['cancelled', 4.5],
      ] as const);
      updatedAt = endsAt;
      if (status === 'failed' || status === 'rolled_back') {
        const at = failable.length ? r.pick(failable) : r.pick(steps);
        stoppedAt = at.label;
        reason = r.pick(FAILS[at.type] ?? ['Step failed']);
        if (
          status === 'rolled_back' &&
          steps.slice(0, steps.indexOf(at)).some((n) => n.type === 'commerce.reserve_inventory')
        )
          reason += '; reservations released';
        stopIndex = steps.indexOf(at);
      } else if (status === 'declined') {
        const at = approvalsInFlow.length ? r.pick(approvalsInFlow) : r.pick(steps);
        stoppedAt = at.label;
        reason = r.pick([
          'Rejected by the approver',
          'No approval decision in time',
          'Outside policy',
        ]);
        stopIndex = steps.indexOf(at);
        if (at.type === 'control.approval')
          approvalRows.push([
            `apr_bench_${id.slice(10)}`,
            id,
            at.id,
            `approval-${at.id}`,
            `${at.label} for ${title}`,
            String((at.config as Record<string, unknown>)?.assignee ?? ''),
            amount,
            reason.startsWith('No') ? 'escalated' : 'rejected',
            null,
            createdAt + HOUR,
            updatedAt,
            reason.startsWith('No') ? null : 'bench@example.com',
          ]);
      } else if (status === 'cancelled') {
        reason = r.pick([
          'Cancelled by the customer',
          'Duplicate order',
          'Cancelled by an operator',
        ]);
        stopIndex = r.int(1, Math.max(1, steps.length - 2));
      }
    }
    counts[status] = (counts[status] ?? 0) + 1;

    orderRows.push([
      id,
      flow.model,
      'bench',
      null,
      business ? null : customer[2],
      status,
      title,
      flow.id,
      version,
      null,
      1,
      customer[0],
      currency,
      amount,
      waitingOn,
      waitingAt,
      waitingSince,
      waitingFor,
      stoppedAt,
      reason,
      createdAt,
      updatedAt,
      fx,
      null,
    ]);

    // Approvals it passed on the way (decided, for the approvals history).
    for (const a of approvalsInFlow)
      if (steps.indexOf(a) < stopIndex && r.chance(0.8))
        approvalRows.push([
          `apr_bench_${id.slice(10)}_${a.id.slice(-4)}`,
          id,
          a.id,
          `approval-${a.id}`,
          `${a.label} for ${title}`,
          String((a.config as Record<string, unknown>)?.assignee ?? ''),
          amount,
          'approved',
          null,
          createdAt + MIN,
          createdAt + r.around(3 * HOUR, 1),
          'bench@example.com',
        ]);

    // Money: a card is taken soon after checkout (so open orders past it have paid too); a B2B
    // invoice is paid when the order completes. Some completed orders are refunded later.
    const paidAt = business ? updatedAt : createdAt + r.around(HOUR, 1.5);
    if (
      !['procurement', 'replenishment'].includes(flow.model) &&
      paidAt < now &&
      (status === 'completed' || (!business && status === 'waiting'))
    ) {
      paymentRows.push([
        `pay_bench_${id.slice(10)}`,
        id,
        business || flow.model === 'subscription' ? 'charge' : 'capture',
        amount,
        'succeeded',
        null,
        paidAt,
        'mock',
        null,
        currency,
      ]);
      const refundAt = updatedAt + r.around(4 * DAY, 0.8);
      if (status === 'completed' && r.chance(0.06) && refundAt < now) {
        const part = r.chance(0.5) ? amount : Math.round(amount * r.next() * 100) / 100;
        paymentRows.push([
          `pay_bench_${id.slice(10)}_r`,
          id,
          'refund',
          part,
          'succeeded',
          null,
          refundAt,
          'mock',
          null,
          currency,
        ]);
      }
    }

    // A timing row per step that finished, for the slowest-steps table.
    let t = createdAt;
    const ran = steps.slice(
      0,
      Math.max(0, stopIndex + (status === 'failed' || status === 'rolled_back' ? 1 : 0)),
    );
    for (const [k, n] of ran.entries()) {
      const ms = stepMs(n.type, r);
      const failed = (status === 'failed' || status === 'rolled_back') && k === ran.length - 1;
      if (t + ms > now) break;
      runRows.push([
        id,
        1,
        n.id,
        1,
        n.type,
        flow.model,
        failed ? 'failed' : 'succeeded',
        t,
        t + ms,
        ms,
      ]);
      t += ms;
    }
  }

  // Carts: people building orders, most of them submitted (to one of the orders above) or left.
  const cartRows: unknown[][] = [];
  const cartFlows = flows.filter((f) => ['b2b', 'b2c', 'd2c', 'procurement'].includes(f.model));
  if (only.has('carts') && cartFlows.length)
    for (let i = 0; i < arg('carts', 1_500); i++) {
      const createdAt = start + Math.floor(r.next() * (now - start));
      const status = r.weighted([
        ['submitted', 55],
        ['open', 18],
        ['canceled', 15],
        ['locked', 4],
        ['returned', 8],
      ] as const);
      const updatedAt = Math.min(now - MIN, createdAt + r.around(6 * HOUR, 1.2));
      const order = status === 'submitted' && orderRows.length ? r.pick(orderRows) : null;
      const customer = r.pick([...companies, ...people]);
      cartRows.push([
        `cart_bench_${i.toString(36).padStart(4, '0')}`,
        r.pick(CART_TITLES),
        status,
        customer[0],
        r.pick(cartFlows).id,
        null,
        null,
        order?.[0] ?? null,
        'bench@example.com',
        createdAt,
        updatedAt,
        status === 'open' ? updatedAt + 14 * DAY : null,
        null,
        null,
      ]);
    }

  const statements = [
    ...CLEANUP,
    ...inserts(
      'customers',
      ['id', 'name', 'email', 'kind', 'tier', 'credit_limit', 'balance', 'terms'],
      [...people, ...companies],
    ),
    ...inserts(
      'products',
      [
        'sku',
        'name',
        'price',
        'cost',
        'stock',
        'reserved',
        'reorder_point',
        'reorder_qty',
        'supplier',
        'seller_id',
        'kind',
      ],
      productRows,
    ),
    ...inserts('location_stock', ['location_id', 'sku', 'stock', 'reserved'], stockRows),
    ...inserts('contract_prices', ['customer_id', 'sku', 'price'], contractRows),
    ...inserts(
      'price_rules',
      [
        'id',
        'source_id',
        'name',
        'sku',
        'customer_id',
        'customer_tier',
        'min_qty',
        'price',
        'discount_pct',
        'starts_at',
        'ends_at',
        'created_at',
      ],
      ruleRows,
    ),
    ...inserts(
      'carts',
      [
        'id',
        'title',
        'status',
        'customer_id',
        'flow_id',
        'plugin_id',
        'session_ref',
        'order_id',
        'created_by',
        'created_at',
        'updated_at',
        'expires_at',
        'buyer_id',
        'purged_at',
      ],
      cartRows,
    ),
    ...inserts(
      'orders',
      [
        'id',
        'model',
        'channel',
        'external_id',
        'contact_email',
        'status',
        'title',
        'flow_id',
        'flow_version',
        'instance_id',
        'generation',
        'customer_id',
        'currency',
        'total',
        'waiting_on',
        'waiting_at',
        'waiting_since',
        'waiting_for',
        'stopped_at',
        'reason',
        'created_at',
        'updated_at',
        'fx_rate',
        'started_by',
      ],
      orderRows,
    ),
    ...inserts(
      'approvals',
      [
        'id',
        'order_id',
        'node_id',
        'event_type',
        'title',
        'assignee',
        'amount',
        'status',
        'note',
        'requested_at',
        'decided_at',
        'decided_by',
      ],
      approvalRows,
    ),
    ...inserts(
      'payments',
      [
        'id',
        'order_id',
        'kind',
        'amount',
        'status',
        'ref',
        'created_at',
        'provider',
        'external_id',
        'currency',
      ],
      paymentRows,
    ),
    ...inserts(
      'node_runs',
      [
        'order_id',
        'generation',
        'node_id',
        'run',
        'node_type',
        'model',
        'status',
        'started_at',
        'ended_at',
        'duration_ms',
      ],
      runRows,
    ),
  ];
  console.log(
    `seed-volume: writing ${orderRows.length} orders over ${days} days (${Object.entries(counts)
      .map(([s, n]) => `${n} ${s}`)
      .join(
        ', ',
      )}), ${approvalRows.length} approvals, ${paymentRows.length} payments, ${runRows.length} step runs, ${productRows.length} products, ${cartRows.length} carts`,
  );
  await run(db, statements);
  console.log('seed-volume: done. `pnpm db:seed:volume --cleanup` removes it.');
}

await main();
