/**
 * An admin's "Update product index" on the Commerce page: one run of the engine's product index
 * reindex now, rather than at the next hourly cron, say after a large import. The engine checks
 * the signed actor's role again and holds a lease, so a run that overlaps the cron's (or a double
 * click) answers `busy` and changes nothing. Every run it answers is audited with its counts.
 */

import { type AuditActor, atLeast, type Principal, type ProductReindex } from '@orderloop/core';
import { actorName, audit } from './audit.server';
import { engine } from './env.server';
import { count } from './format';
import { signedActor } from './principal.server';

/** The run, and what it did in one line for the page. */
export type ProductIndexResult =
  | { ok: true; run: ProductReindex; message: string }
  | { ok: false; error: string };

export async function updateProductIndex(
  request: Request,
  by: Principal & AuditActor,
): Promise<ProductIndexResult> {
  if (!atLeast(by.role, 'admin')) return { ok: false, error: 'This needs the Admin role.' };
  try {
    const r = await engine().reindexProducts(
      await signedActor(
        { kind: 'staff', id: by.id, name: actorName(by), role: by.role },
        'reindex-products',
      ),
    );
    if (!r.ok) return r;
    await audit(request, 'catalog.products_indexed', { actor: by, detail: { ...r.value } });
    return { ok: true, run: r.value, message: describeRun(r.value) };
  } catch (err) {
    console.error('product index update failed', err);
    return {
      ok: false,
      error: 'Could not update the product index. What it finished is kept; try again in a moment.',
    };
  }
}

/** What the run did, in one line for the page. */
export function describeRun(run: ProductReindex): string {
  switch (run.status) {
    case 'no_index':
      return 'This workspace has no product index, so extraction matches products by their SKUs and words alone.';
    case 'busy':
      return 'The product index is already being updated. Try again in a few minutes.';
    case 'done': {
      if (!run.indexed && !run.removed) return 'The product index is up to date.';
      return `Updated the product index: ${count(run.indexed)} added or renamed, ${count(run.removed)} removed.${
        run.more ? ' More products are waiting; they follow within the hour, or run it again.' : ''
      }`;
    }
  }
}
