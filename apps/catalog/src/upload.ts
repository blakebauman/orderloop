/**
 * Stores a stream of unknown length in R2. A put needs a known length, so anything over one part
 * goes up as a multipart upload in 10 MiB parts (R2's minimum is 5 MiB for all but the last).
 * Memory holds one part at a time, whatever the size of the feed.
 */
const PART_BYTES = 10 * 1024 * 1024;

export async function storeStream(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
): Promise<number> {
  const reader = body.getReader();
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
      const { value, done } = await reader.read();
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
    await upload?.abort().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}
