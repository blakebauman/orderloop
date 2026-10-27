import { data } from 'react-router';
import {
  catalogDiscardInput,
  catalogDraftContentInput,
  catalogEditsInput,
  catalogPublishInput,
} from '~/lib/api-schemas';
import { requireUser } from '~/lib/auth.server';
import { BodyTooLarge, readText } from '~/lib/body';
import {
  acceptDrafts,
  discardDrafts,
  discardStaged,
  draftProduct,
  publish,
  stageEdits,
} from '~/lib/catalog-board.server';
import type { Route } from './+types/catalog-action';

const refused = (error: string, status = 400) => data({ ok: false as const, error }, { status });

/**
 * JSON actions from the Catalog page, as the signed-in operator: stage, discard and publish edits,
 * accept or drop the assistant's drafts, and have it draft a product. Each answers JSON, so the
 * page can draft a group of products one after another and say how far it got.
 */
export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readText(request));
  } catch (err) {
    if (err instanceof BodyTooLarge) return refused(err.message, 413);
    return refused('Body must be JSON');
  }
  const key = typeof body.key === 'string' && body.key ? body.key.slice(0, 128) : null;
  switch (body.intent) {
    case 'stage': {
      const p = catalogEditsInput.safeParse(body);
      if (!p.success) return refused('Those edits don’t read.');
      return { ok: true as const, results: await stageEdits(request, me, p.data.edits) };
    }
    case 'accept': {
      if (!key) return refused('Name the product.');
      return { ok: true as const, results: await acceptDrafts(request, me, key) };
    }
    case 'discard-staged':
    case 'discard-drafts': {
      const p = catalogDiscardInput.safeParse(body);
      if (!p.success) return refused('Name what to drop.');
      const drop = body.intent === 'discard-staged' ? discardStaged : discardDrafts;
      return { ok: true as const, ...(await drop(request, me, p.data.items)) };
    }
    case 'publish': {
      const p = catalogPublishInput.safeParse(body);
      if (!p.success || !p.data.requestId) return refused('Name the products to publish.');
      return {
        ok: true as const,
        results: await publish(request, me, p.data.keys, p.data.requestId),
      };
    }
    case 'draft': {
      const p = catalogDraftContentInput.safeParse({
        fields: body.fields,
        instruction: body.instruction,
      });
      if (!key || !p.success) return refused('Name the product to draft.');
      const r = await draftProduct(request, me, key, p.data);
      return r.ok ? { ok: true as const, draft: r.value } : refused(r.error, 422);
    }
  }
  return refused('Unknown action');
}
