/** Where a newest-first page of orders ended: the last row's creation time and id (ids break ties). */
export type OrderCursor = { createdAt: number; id: string };

/** An opaque cursor string for the API. */
export const encodeCursor = (c: OrderCursor) => btoa(`${c.createdAt}:${c.id}`);

/** The cursor a client sent back, or null when it isn't one of ours. */
export function decodeCursor(s: string | null): OrderCursor | null {
  if (!s) return null;
  try {
    const [at, ...id] = atob(s).split(':');
    const createdAt = Number(at);
    return at && Number.isFinite(createdAt) && id.length && id.join(':')
      ? { createdAt, id: id.join(':') }
      : null;
  } catch {
    return null;
  }
}
