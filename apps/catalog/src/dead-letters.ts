/**
 * The consumer of the catalog's three dead-letter queues (feed parts, listing changes, purges).
 * A message lands in one only after its own consumer gave up, so nothing here tries to apply it:
 * each is kept in R2 under `dlq/<queue>/<date>/<id>.json` for inspection and replay
 * (docs/operations.md, "Dead letters"), logged once, then acknowledged.
 *
 * The log line goes out at error level: Workers Observability counts error logs as failures in
 * its Issues, which is what alerts on it. It names the queue and the message, never the body.
 */

/** A dead-letter queue's name: a catalog queue's base name, `-dlq`, then the deployment's suffix. */
export const isDeadLetterQueue = (queue: string) =>
  /^orderloop-catalog-(feed-parts|changes|purge)-dlq(-|$)/.test(queue);

/** Where a dead letter is kept: by queue, the day it was sent and its id, so a redelivery overwrites it. */
export const deadLetterKey = (queue: string, msg: Message) =>
  `dlq/${queue}/${msg.timestamp.toISOString().slice(0, 10)}/${msg.id}.json`;

/** Keeps each message in `bucket`, then acknowledges it; one that can't be written is retried. */
export async function keepDeadLetters(
  batch: MessageBatch,
  bucket: R2Bucket,
  backoff: (attempts: number) => number,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        await bucket.put(
          deadLetterKey(batch.queue, msg),
          JSON.stringify({
            queue: batch.queue,
            id: msg.id,
            timestamp: msg.timestamp.toISOString(),
            attempts: msg.attempts,
            body: msg.body,
          }),
          { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
        );
      } catch (err) {
        console.error(`dead letter ${msg.id} from ${batch.queue} not kept:`, err);
        msg.retry({ delaySeconds: backoff(msg.attempts) });
        return;
      }
      console.error(
        JSON.stringify({
          type: 'dlq_message',
          queue: batch.queue,
          id: msg.id,
          attempts: msg.attempts,
        }),
      );
      msg.ack();
    }),
  );
}
