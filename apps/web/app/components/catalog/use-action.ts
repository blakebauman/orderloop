import type { AssistantTool } from '@orderloop/core';
import type { EditResult, ProductDraftResult, PublishResult } from '@orderloop/core/product';
import { useCallback, useState } from 'react';
import { useRevalidator } from 'react-router';
import { type ActResult, useAssistant } from '~/lib/assistant';

/** What a Catalog write answers. */
export type CatalogAnswer =
  | {
      ok: true;
      results?: EditResult[] | PublishResult[];
      draft?: ProductDraftResult;
      discarded?: number;
    }
  | { ok: false; error: string };

/** A Catalog write, as the page names it. */
export type CatalogWrite =
  | { intent: 'stage'; edits: unknown[] }
  | { intent: 'accept'; key: string }
  | { intent: 'discard-staged' | 'discard-drafts'; items: unknown[] }
  | { intent: 'publish'; keys: string[] }
  | { intent: 'draft'; key: string; fields?: unknown[]; instruction?: string };

/** The assistant tool call for a write. */
function callFor(w: CatalogWrite): [AssistantTool, unknown] {
  switch (w.intent) {
    case 'stage':
      return ['stage_product_edits', { edits: w.edits }];
    case 'accept':
      return ['accept_product_drafts', { key: w.key }];
    case 'discard-staged':
      return ['discard_product_edits', { what: 'staged', items: w.items }];
    case 'discard-drafts':
      return ['discard_product_edits', { what: 'drafts', items: w.items }];
    case 'publish':
      return ['publish_catalog', { keys: w.keys }];
    case 'draft':
      return [
        'draft_product_content',
        {
          key: w.key,
          ...(w.fields ? { fields: w.fields } : {}),
          ...(w.instruction ? { instruction: w.instruction } : {}),
        },
      ];
  }
}

/** A write's answer from what the assistant's tool returned; null when the person declined. */
export function answerOf(w: CatalogWrite, r: ActResult): CatalogAnswer | null {
  if ('declined' in r) return null;
  const out = (r.output ?? {}) as {
    results?: EditResult[] | PublishResult[];
    discarded?: number;
  };
  return w.intent === 'draft'
    ? { ok: true, draft: r.output as ProductDraftResult }
    : { ok: true, results: out.results, discarded: out.discarded };
}

/** Makes one write through the assistant; a refusal comes back as `{ ok: false }`. */
export async function catalogWrite(
  act: (tool: AssistantTool, input: unknown) => Promise<ActResult>,
  w: CatalogWrite,
): Promise<CatalogAnswer | null> {
  try {
    return answerOf(w, await act(...callFor(w)));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One write from the Catalog page, through the assistant as a tool call of its own: publishing
 * stops at its confirm card, the rest run at once. The page's loader revalidates after it, so the
 * board and an open sheet show where the product went.
 */
export function useCatalogAction() {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<CatalogAnswer | undefined>();
  const run = useCallback(
    async (w: CatalogWrite) => {
      setBusy(true);
      setAnswer(undefined);
      const a = await catalogWrite(act, w);
      setAnswer(a ?? undefined);
      setBusy(false);
      if (a?.ok) revalidate();
    },
    [act, revalidate],
  );
  return { run: (w: CatalogWrite) => void run(w), busy, answer };
}

/** Why the catalog refused a write, from an answer: the error, or the first refused edit's issues. */
export function refusal(a: CatalogAnswer | undefined): string | null {
  if (!a) return null;
  if (!a.ok) return a.error;
  const bad = (a.results as EditResult[] | undefined)?.find((r) => 'ok' in r && !r.ok);
  return bad && 'issues' in bad ? bad.issues.join('; ') : null;
}
