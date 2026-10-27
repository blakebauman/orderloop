/**
 * Seeds everything, in order, so every page of a local workspace has data: migrations, the demo
 * data, generated volume, the records seed (team and dev admin, promotions, tax certificates,
 * email intake, audit history, order records) and, when `pnpm web:dev` answers, the live seed
 * (real scenario orders, carts and the catalog demo). See docs/local-development.md, "Seed
 * everything".
 *
 *   pnpm db:seed:all [--url http://localhost:5173] [--orders 20000] [--days 90]
 */

import { spawnSync } from 'node:child_process';
import { failWith, LOCAL_LOGIN, readLocalLogin, WEB } from './seed-lib';

const fail: (message: string) => never = failWith('seed-all');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

const url = (flag('url') ?? 'http://localhost:5173').replace(/\/$/, '');
const volume = ['orders', 'days'].flatMap((n) => (flag(n) ? [`--${n}`, flag(n)!] : []));

/** Runs one seed; `quiet` holds back wrangler's output unless it fails. */
function step(label: string, cmd: string, args: string[], quiet = false) {
  console.log(`\n▸ ${label}`);
  const r = spawnSync(cmd, args, { cwd: WEB, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.status === 0) return;
  if (quiet) console.error(r.stdout, r.stderr);
  fail(`${label} failed`);
}

step('Migrations', 'pnpm', ['run', 'db:migrate:local'], true);
step('Demo data', 'pnpm', ['run', 'db:seed:local'], true);
step('Generated orders, products and carts', 'pnpm', [
  'exec',
  'tsx',
  'scripts/seed-volume.ts',
  ...volume,
]);
step('Team, promotions, certificates, intake, audit and order records', 'pnpm', [
  'exec',
  'tsx',
  'scripts/seed-records.ts',
]);

const up = await fetch(`${url}/api/v1/flows`).then(
  () => true,
  () => false,
);
if (up)
  step('Live orders, carts and the catalog', 'pnpm', ['exec', 'tsx', 'scripts/seed-live.ts', url]);
else
  console.log(
    `\nNothing answers at ${url}, so the live seed was skipped. Start \`pnpm web:dev\`, then run \`pnpm db:seed:live\` (add the URL if Vite isn't on 5173).`,
  );

const login = readLocalLogin();
console.log(
  `\nDone. Sign in at ${url}/login as ${login?.email} with the password in ${LOCAL_LOGIN}.`,
);
