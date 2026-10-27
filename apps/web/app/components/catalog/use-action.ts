import type { EditResult, ProductDraftResult, PublishResult } from '@orderloop/core/product';
import { useFetcher } from 'react-router';

/** What `/catalog/action` answers (routes/catalog-action.ts). */
export type CatalogAnswer =
  | {
      ok: true;
      results?: EditResult[] | PublishResult[];
      draft?: ProductDraftResult;
      discarded?: number;
    }
  | { ok: false; error: string };

export const CATALOG_ACTION = '/catalog/action';

/**
 * One write from the Catalog page, as JSON to `/catalog/action`. The page's loader revalidates
 * after it, so the board and an open sheet show where the product went.
 */
export function useCatalogAction() {
  const fetcher = useFetcher<CatalogAnswer>();
  return {
    run: (body: Record<string, unknown>) =>
      fetcher.submit(body as never, {
        method: 'post',
        action: CATALOG_ACTION,
        encType: 'application/json',
      }),
    busy: fetcher.state !== 'idle',
    answer: fetcher.state === 'idle' ? fetcher.data : undefined,
  };
}

/** Why the catalog refused a write, from an answer: the error, or the first refused edit's issues. */
export function refusal(a: CatalogAnswer | undefined): string | null {
  if (!a) return null;
  if (!a.ok) return a.error;
  const bad = (a.results as EditResult[] | undefined)?.find((r) => 'ok' in r && !r.ok);
  return bad && 'issues' in bad ? bad.issues.join('; ') : null;
}
