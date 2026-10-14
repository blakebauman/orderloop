/** Request bodies, read with a size cap so a large upload can't exhaust the Worker. */

/** Most JSON bodies. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** An X12 interchange may carry many purchase orders. */
export const MAX_EDI_BYTES = 5 * 1024 * 1024;

export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`Request body must be at most ${limit} bytes`);
  }
}

/** The body as text, or `BodyTooLarge` once it passes `limit` bytes (checked as it streams). */
export async function readText(request: Request, limit = MAX_BODY_BYTES): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new BodyTooLarge(limit);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BodyTooLarge(limit);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The 413 for a body over its cap. */
export const tooLarge = (err: BodyTooLarge) =>
  Response.json({ error: err.message }, { status: 413 });
