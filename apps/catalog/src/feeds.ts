/**
 * CatalogFeeds: the one object tracking every feed's progress. The FeedImport Workflow records each
 * chunk it splits, the parts consumer records each part a shard applied, and both are idempotent
 * (by chunk number and part id), so a retried step or a redelivered message never counts twice.
 * A feed is done when its split has finished and every part it produced has been applied.
 */
import { DurableObject } from 'cloudflare:workers';
import { FEED_ERRORS, type FeedFormat, type FeedStatus } from '@orderloop/core/product';

export type FeedError = FeedStatus['errors'][number];
export type PartCounts = { created: number; updated: number; unchanged: number; rejected: number };

export class CatalogFeeds extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feeds_created ON feeds (created_at);
      CREATE TABLE IF NOT EXISTS chunks (feed TEXT NOT NULL, chunk INTEGER NOT NULL, PRIMARY KEY (feed, chunk));
      CREATE TABLE IF NOT EXISTS parts (feed TEXT NOT NULL, part TEXT NOT NULL, PRIMARY KEY (feed, part));
    `);
  }

  private read(id: string): FeedStatus | null {
    const row = this.sql
      .exec<{ body: string }>('SELECT body FROM feeds WHERE id = ?', id)
      .toArray()[0];
    return row ? (JSON.parse(row.body) as FeedStatus) : null;
  }

  private write(s: FeedStatus) {
    this.sql.exec('UPDATE feeds SET body = ? WHERE id = ?', JSON.stringify(s), s.id);
  }

  private addErrors(s: FeedStatus, errors: FeedError[]) {
    for (const e of errors) if (s.errors.length < FEED_ERRORS) s.errors.push(e);
    s.errors.sort((a, b) => a.row - b.row);
  }

  create(input: { id: string; name: string; format: FeedFormat; by: string }): FeedStatus {
    const status: FeedStatus = {
      ...input,
      state: 'queued',
      createdAt: Date.now(),
      rows: 0,
      parts: 0,
      partsDone: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      errors: [],
    };
    this.sql.exec(
      'INSERT INTO feeds VALUES (?, ?, ?)',
      status.id,
      status.createdAt,
      JSON.stringify(status),
    );
    return status;
  }

  get(id: string): FeedStatus | null {
    return this.read(id);
  }

  list(limit: number): FeedStatus[] {
    return this.sql
      .exec<{ body: string }>('SELECT body FROM feeds ORDER BY created_at DESC LIMIT ?', limit)
      .toArray()
      .map((r) => JSON.parse(r.body) as FeedStatus);
  }

  /** One split step's output: rows read, parts sent, rows refused before reaching a shard. */
  chunkSplit(
    id: string,
    chunk: number,
    out: { rows: number; parts: number; rejected: number; errors: FeedError[] },
  ): FeedStatus | null {
    const s = this.read(id);
    if (!s) return null;
    const seen = this.sql
      .exec('SELECT 1 FROM chunks WHERE feed = ? AND chunk = ?', id, chunk)
      .toArray();
    if (seen.length) return s;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO chunks VALUES (?, ?)', id, chunk);
      if (s.state === 'queued') s.state = 'splitting';
      s.rows += out.rows;
      s.parts += out.parts;
      s.rejected += out.rejected;
      this.addErrors(s, out.errors);
      this.write(s);
    });
    return s;
  }

  /** The split has read the whole file: from now on the feed finishes when its parts do. */
  splitDone(id: string): FeedStatus | null {
    const s = this.read(id);
    if (!s || s.state === 'failed' || s.state === 'done') return s;
    s.state = 'applying';
    this.write(s);
    return s;
  }

  /** A part a shard has applied. Returns whether the feed's last part just finished. */
  partDone(
    id: string,
    part: string,
    counts: PartCounts,
    errors: FeedError[],
  ): { complete: boolean } {
    const s = this.read(id);
    if (!s) return { complete: false };
    const seen = this.sql
      .exec('SELECT 1 FROM parts WHERE feed = ? AND part = ?', id, part)
      .toArray();
    if (!seen.length)
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('INSERT INTO parts VALUES (?, ?)', id, part);
        s.partsDone += 1;
        s.created += counts.created;
        s.updated += counts.updated;
        s.unchanged += counts.unchanged;
        s.rejected += counts.rejected;
        this.addErrors(s, errors);
        this.write(s);
      });
    return { complete: s.state === 'applying' && s.partsDone >= s.parts };
  }

  finish(id: string): FeedStatus | null {
    const s = this.read(id);
    if (!s || s.state === 'failed') return s;
    s.state = 'done';
    s.finishedAt ??= Date.now();
    this.write(s);
    return s;
  }

  fail(id: string, failure: string): FeedStatus | null {
    const s = this.read(id);
    if (!s || s.state === 'done') return s;
    s.state = 'failed';
    s.failure = failure.slice(0, 1_000);
    s.finishedAt = Date.now();
    this.write(s);
    return s;
  }
}
