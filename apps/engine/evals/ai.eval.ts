/**
 * Evals: the golden set (cases.ts) against the live models, through the same prompt code the
 * steps use (src/ai.ts). Run by .github/workflows/evals.yml on a schedule and on changes to the
 * prompts or models, never as a required check: a model is not deterministic. Locally:
 * CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @orderloop/engine evals
 *
 * Each task passes when enough of its cases do. An answer from the heuristic fallback counts as a
 * failure: the eval measures the model.
 */

import { appendFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { extractOrder, riskScore, route } from '../src/ai';
import { CATALOG, EXTRACT, RISK, ROUTER, ROUTER_INSTRUCTIONS, ROUTES } from './cases';
import { hasCredentials, liveEnv } from './live-env';

/** The share of a task's cases that must pass. */
const PASS_RATE = 0.8;

type Result = { task: string; name: string; ok: boolean; got: string; fallback?: string };
const results: Result[] = [];

const sameLines = (a: { sku: string; qty: number }[], b: { sku: string; qty: number }[]) =>
  JSON.stringify([...a].sort((x, y) => x.sku.localeCompare(y.sku)).map((l) => [l.sku, l.qty])) ===
  JSON.stringify([...b].sort((x, y) => x.sku.localeCompare(y.sku)).map((l) => [l.sku, l.qty]));

const rate = (task: string) => {
  const mine = results.filter((r) => r.task === task);
  return mine.filter((r) => r.ok).length / mine.length;
};

describe.skipIf(!hasCredentials)('AI evals (live)', () => {
  const env = liveEnv();

  it('extracts orders from documents', async () => {
    for (const c of EXTRACT) {
      const r = await extractOrder(env, c.text, CATALOG);
      const ok =
        r.source === 'model' &&
        sameLines(r.value.lines, c.lines) &&
        (c.poNumber === undefined || r.value.poNumber === c.poNumber);
      results.push({
        task: 'extract',
        name: c.name,
        ok,
        got: `${r.value.lines.map((l) => `${l.qty}×${l.sku}`).join(', ')} · PO ${r.value.poNumber}`,
        fallback: r.fallback,
      });
    }
    expect(rate('extract')).toBeGreaterThanOrEqual(PASS_RATE);
  });

  it('routes orders as the instructions say', async () => {
    for (const c of ROUTER) {
      const r = await route(env, ROUTER_INSTRUCTIONS, ROUTES, {
        order: c.order,
        customer: c.customer,
      });
      results.push({
        task: 'router',
        name: c.name,
        ok: r.source === 'model' && r.value.route === c.route,
        got: `${r.value.route}: ${r.value.reason}`,
        fallback: r.fallback,
      });
    }
    expect(rate('router')).toBeGreaterThanOrEqual(PASS_RATE);
  });

  it('scores risk in the right band', async () => {
    for (const c of RISK) {
      const r = await riskScore(env, c.order, c.customer);
      const s = r.value.score;
      results.push({
        task: 'risk',
        name: c.name,
        ok: r.source === 'model' && (c.band === 'low' ? s < 40 : s >= 60),
        got: `${s}: ${r.value.reasons.join('; ')}`,
        fallback: r.fallback,
      });
    }
    expect(rate('risk')).toBeGreaterThanOrEqual(PASS_RATE);
  });

  afterAll(() => {
    const rows = results.map(
      (r) =>
        `| ${r.task} | ${r.ok ? 'pass' : 'FAIL'} | ${r.name} | ${(r.fallback ? `fallback: ${r.fallback}` : r.got).replace(/\|/g, '/').slice(0, 160)} |`,
    );
    const tasks = [...new Set(results.map((r) => r.task))].map(
      (t) => `${t} ${Math.round(rate(t) * 100)}%`,
    );
    const report = [
      `## AI evals: ${tasks.join(' · ')} (pass at ${PASS_RATE * 100}%)`,
      '',
      '| Task | Result | Case | Answer |',
      '|---|---|---|---|',
      ...rows,
      '',
    ].join('\n');
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  });
});

it.skipIf(hasCredentials)(
  'needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to call the models',
  () => {
    console.log('AI evals skipped: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
  },
);
