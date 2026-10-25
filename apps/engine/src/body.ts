/**
 * Reading a request or response body without trusting its size: the bytes are counted as they
 * arrive and reading stops past `max`, so an oversized body is never held whole.
 */

/** The body's bytes, or null once it passes `max`. */
export async function readCapped(stream: ReadableStream<Uint8Array>, max: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/** The body as text, or null once it passes `max` bytes (an empty body is `''`). */
export async function readCappedText(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const bytes = await readCapped(request.body, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * Why an Idempotency-Key can't be used, or null: UCP asks for 16–255 characters, whichever
 * transport (REST header or MCP meta) carries it.
 */
export const idempotencyKeyProblem = (key: string) =>
  key.length < 16 || key.length > 255 ? 'Idempotency-Key must be 16–255 characters.' : null;
