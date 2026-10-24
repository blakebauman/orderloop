/**
 * Stores a stream of unknown length in R2. A put needs a known length, so anything over one part
 * goes up as a multipart upload in 10 MiB parts (R2's minimum is 5 MiB for all but the last).
 * Memory holds one part at a time, whatever the size of the feed.
 */
const PART_BYTES = 10 * 1024 * 1024;
/** How long an upload may send nothing before it is given up as stalled. */
export const UPLOAD_IDLE_MS = 30_000;

/** An upload that sent nothing for `UPLOAD_IDLE_MS` (the message crosses RPC; the class doesn't). */
export class UploadStalled extends Error {
  constructor(ms: number) {
    super(`upload stalled: no bytes for ${Math.round(ms / 1000)} s`);
  }
}

export async function storeStream(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  idleMs = UPLOAD_IDLE_MS,
): Promise<number> {
  const reader = body.getReader();
  // A read that never settles (a caller gone without closing its stream) times out here instead of
  // hanging until the runtime cancels the request, so the multipart upload is aborted and the
  // caller hears why.
  const read = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UploadStalled(idleMs)), idleMs);
    });
    // Cleared once the read settles, so a feed of many chunks leaves no timers behind.
    return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
  };
  let chunks: Uint8Array[] = [];
  let buffered = 0;
  let total = 0;
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  const take = () => {
    const out = new Uint8Array(buffered);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    chunks = [];
    buffered = 0;
    return out;
  };
  try {
    for (;;) {
      const { value, done } = await read();
      if (value?.length) {
        chunks.push(value);
        buffered += value.length;
        total += value.length;
      }
      if (buffered >= PART_BYTES || (done && upload && buffered)) {
        upload ??= await bucket.createMultipartUpload(key);
        parts.push(await upload.uploadPart(parts.length + 1, take()));
      }
      if (done) break;
    }
    if (!upload) {
      await bucket.put(key, take());
      return total;
    }
    await upload.complete(parts);
    return total;
  } catch (err) {
    await reader.cancel(err).catch(() => {});
    await upload?.abort().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}
