/**
 * Paging for the Commerce page's lists. Each list (inventory, customers, sellers, a store's stock,
 * a pricing source's entries) keeps its own page in the URL under its own key, so moving through
 * one leaves the others where they are. Pure, so it is tested without D1 (tests/commerce-pages.test.ts).
 */

/** Rows per page of a section's list. */
export const LIST_SIZE = 25;
/** Rows per page of a list inside a section: one store's stock, one pricing source's entries. */
export const GROUP_SIZE = 10;

export type Paged<T> = { rows: T[]; total: number; page: number; size: number };

export const storeKey = (locationId: string) => `store-${locationId}`;
export const pricesKey = (sourceId: string) => `prices-${sourceId}`;

/** The page a list is on: a whole number from 1, anything else is the first page. */
export function pageOf(params: URLSearchParams, key: string): number {
  const n = Number(params.get(key));
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** The last page a list has (1 when it is empty), so a page past the end shows the last one. */
export const lastPage = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

/** A link to another page of one list, keeping every other parameter, back at its section. */
export function pageHref(params: URLSearchParams, key: string, page: number, hash: string) {
  const next = new URLSearchParams(params);
  if (page > 1) next.set(key, String(page));
  else next.delete(key);
  const s = next.toString();
  return `${s ? `?${s}` : '/commerce'}#${hash}`;
}

/** "26–50 of 2,000": the rows a page shows, counted from 1. */
export function shown(list: Pick<Paged<unknown>, 'page' | 'size' | 'total'>) {
  const first = Math.min(list.total, (list.page - 1) * list.size + 1);
  const last = Math.min(list.total, list.page * list.size);
  return { first, last };
}
