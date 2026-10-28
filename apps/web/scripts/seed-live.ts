/**
 * The seed that needs the engine: with `pnpm web:dev` running, it starts every demo scenario as a
 * real order (so order pages have their graph and timeline, approvals their context, Commerce its
 * outside events), and the ones that stop for a person or an outside event several more times, so
 * the overview's open work and the approvals queue have live rows (generated orders have no run,
 * so they are all history). It also builds carts in the engine (open, locked, submitted and canceled), through
 * the REST API as the local dev admin (`pnpm db:seed:records` writes the token). The catalog demo
 * (`seed-catalog.ts`) runs with the same token. See docs/local-development.md, "Seed everything".
 *
 *   pnpm db:seed:live [http://localhost:5173]
 */

import { SCENARIOS } from '../app/lib/scenarios';
import { failWith, readLocalLogin } from './seed-lib';

const fail: (message: string) => never = failWith('seed-live');

// `pnpm db:seed:live <url>` passes a `--` before the URL.
const origin = (
  process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:5173'
).replace(/\/$/, '');
const login = readLocalLogin();
const token = process.env.ORDERLOOP_API_TOKEN ?? login?.token;
if (!token) fail('no API token: run `pnpm db:seed:records` first, or set ORDERLOOP_API_TOKEN');

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(`${origin}/api/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const ping = await fetch(`${origin}/api/v1/flows`, {
  headers: { authorization: `Bearer ${token}` },
}).catch(() => null);
if (!ping) fail(`nothing answers at ${origin}; start \`pnpm web:dev\` first`);
if (ping.status === 401)
  fail('the API refused the token; run `pnpm db:seed:records` again to restore it');

/**
 * How many orders each scenario starts in all. Those that stop for a person (an approval) or an
 * outside event (payment, a seller's answer, a pickup) run several times, so there is open work to
 * see and decide; the rest run once.
 */
const RUNS: Record<string, number> = {
  'b2b-credit': 6,
  purchase: 6,
  'b2b-email': 5,
  marketplace: 5,
  pickup: 4,
};

// Some finish, some wait at an approval or an event, some fail on purpose. Each order has its own
// Idempotency-Key (`seed-live:<scenario>`, then `:2`, `:3`…), so a re-run finds the orders it
// started before rather than starting more.
let started = 0;
let kept = 0;
for (const s of SCENARIOS)
  for (let n = 1; n <= (RUNS[s.id] ?? 1); n++) {
    const r = await api<{ orderId?: string; replayed?: boolean; error?: string }>(
      'POST',
      'orders',
      { flowId: s.flowId, input: s.input },
      { 'idempotency-key': n === 1 ? `seed-live:${s.id}` : `seed-live:${s.id}:${n}` },
    );
    if (r.ok && r.body?.replayed) kept++;
    else if (r.ok) started++;
    else console.log(`order ${s.id} #${n}: ${r.status} ${r.body?.error ?? ''}`);
  }
console.log(`seed-live: started ${started} scenario orders, ${kept} already there`);

// Carts on the flows that price them, in each state the Carts page shows.
type Cart = { cart?: { id: string; version?: number }; error?: string };
const CARTS: {
  title: string;
  flowId: string;
  customerId: string;
  lines: [string, number][];
  end?: 'lock' | 'submit' | 'cancel';
}[] = [
  {
    title: 'Q4 restock: bearings and gaskets',
    flowId: 'tpl-b2b-order',
    customerId: 'cus_northwind',
    lines: [
      ['BRG-608', 200],
      ['GSK-010', 60],
    ],
  },
  {
    title: 'Workshop widgets',
    flowId: 'tpl-b2b-order',
    customerId: 'cus_contoso',
    lines: [
      ['WID-100', 40],
      ['WID-200', 12],
    ],
    end: 'lock',
  },
  {
    title: 'Servo motors for line 3',
    flowId: 'tpl-b2b-order',
    customerId: 'cus_fabrikam',
    lines: [
      ['MTR-750', 4],
      ['BRG-608', 50],
    ],
    end: 'submit',
  },
  {
    title: 'Monitors for the new office',
    flowId: 'tpl-b2b-order',
    customerId: 'cus_contoso',
    lines: [['MON-27', 12]],
    end: 'cancel',
  },
  {
    title: 'Kettle and tees',
    flowId: 'tpl-storefront-order',
    customerId: 'cus_ada',
    lines: [
      ['KET-01', 1],
      ['TEE-01', 3],
    ],
  },
];
const SHIP_TO = {
  name: 'Receiving dock',
  line1: '500 Industrial Way',
  city: 'Oakland',
  region: 'CA',
  postalCode: '94607',
  country: 'US',
};
// Carts already made by an earlier run (by title) are left as they are.
const existing = new Set(
  ((await api<{ carts?: { title: string }[] }>('GET', 'carts?limit=200')).body?.carts ?? []).map(
    (c) => c.title,
  ),
);
let carts = 0;
let skipped = 0;
for (const c of CARTS) {
  if (existing.has(c.title)) {
    skipped++;
    continue;
  }
  const made = await api<Cart>('POST', 'carts', {
    title: c.title,
    flowId: c.flowId,
    customerId: c.customerId,
  });
  const id = made.body?.cart?.id;
  if (!made.ok || !id) {
    console.log(`cart "${c.title}": ${made.status} ${made.body?.error ?? ''}`);
    continue;
  }
  carts++;
  for (const [sku, qty] of c.lines) await api('POST', `carts/${id}/ops`, { op: 'add', sku, qty });
  await api('POST', `carts/${id}/ops`, { op: 'set_ship_to', address: SHIP_TO });
  if (!c.end) continue;
  const r =
    c.end === 'lock'
      ? await api('POST', `carts/${id}/ops`, { op: 'lock' })
      : await api('POST', `carts/${id}/${c.end}`, {});
  if (!r.ok) console.log(`cart "${c.title}" ${c.end}: ${r.status} ${JSON.stringify(r.body)}`);
}
console.log(`seed-live: made ${carts} carts, ${skipped} already there`);

// The catalog's demo shop, as the same admin.
process.env.ORDERLOOP_API_TOKEN = token;
process.argv = [process.argv[0]!, process.argv[1]!, origin];
await import('./seed-catalog');
