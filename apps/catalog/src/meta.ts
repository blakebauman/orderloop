/**
 * CatalogMeta: the one object holding product types (every version), channels and the category
 * tree. Writes are rare (an admin adding a type or a category); reads are cached by callers per
 * `rev`. Categories publish as one tree document per channel and locale.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  type CategoriesResult,
  type Category,
  type CategoryInput,
  type Channel,
  type ChannelResult,
  categorySchema,
  channelSchema,
  type DeleteResult,
  DOC_FORMAT,
  type ProductType,
  type ProductTypeInput,
  paths,
  pickLocale,
  productTypeSchema,
  type TypeResult,
  typeChangeIssues,
} from '@orderloop/core/product';
import type { CatalogConfig } from './config';

export class CatalogMeta extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS types (
        code TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL,
        by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (code, version));
      CREATE TABLE IF NOT EXISTS channels (code TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS categories (code TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('rev', 0);
    `);
  }

  private bump() {
    this.sql.exec(`UPDATE settings SET v = v + 1 WHERE k = 'rev'`);
  }

  getConfig(): CatalogConfig {
    const rev = this.sql.exec<{ v: number }>(`SELECT v FROM settings WHERE k = 'rev'`).one().v;
    const types = this.sql
      .exec<{ body: string }>('SELECT body FROM types ORDER BY code, version')
      .toArray()
      .map((r) => JSON.parse(r.body) as ProductType);
    return { rev, types, channels: this.channels() };
  }

  putType(input: ProductTypeInput, by: string): TypeResult {
    const parsed = productTypeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => i.message) };
    const type = parsed.data;
    const prev = this.sql
      .exec<{ body: string }>(
        'SELECT body FROM types WHERE code = ? ORDER BY version DESC LIMIT 1',
        type.code,
      )
      .toArray()[0];
    if (prev) {
      const issues = typeChangeIssues(JSON.parse(prev.body) as ProductType, type);
      if (issues.length) return { ok: false, issues };
    } else if (type.version !== 1) return { ok: false, issues: ['a new type starts at version 1'] };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO types VALUES (?, ?, ?, ?, ?)',
        type.code,
        type.version,
        JSON.stringify(type),
        by,
        Date.now(),
      );
      this.bump();
    });
    return { ok: true, type };
  }

  /** Removes every version of a type (the caller checked no product uses it). */
  deleteType(code: string): { versions: number } {
    const versions = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM types WHERE code = ?', code)
      .one().n;
    if (versions)
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM types WHERE code = ?', code);
        this.bump();
      });
    return { versions };
  }

  listTypes(): ProductType[] {
    return this.sql
      .exec<{ body: string }>(
        `SELECT body FROM types t WHERE version = (SELECT MAX(version) FROM types WHERE code = t.code)
         ORDER BY code`,
      )
      .toArray()
      .map((r) => JSON.parse(r.body) as ProductType);
  }

  /**
   * Adds or changes a channel. A changed currency or locale list only reaches documents already
   * published when they're re-rendered (CatalogApi.reindex).
   */
  async putChannel(input: Channel): Promise<ChannelResult> {
    const parsed = channelSchema.safeParse(input);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => i.message) };
    const channel = parsed.data;
    if (!channel.locales.includes(channel.defaultLocale))
      return { ok: false, issues: ['defaultLocale must be one of locales'] };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT OR REPLACE INTO channels VALUES (?, ?)',
        channel.code,
        JSON.stringify(channel),
      );
      this.bump();
    });
    await this.publishCategories([channel]);
    return { ok: true, channel };
  }

  /** Removes a channel and its category trees. Returns it, or null when there was none. */
  async deleteChannel(code: string): Promise<Channel | null> {
    const channel = this.channels().find((c) => c.code === code) ?? null;
    if (!channel) return null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM channels WHERE code = ?', code);
      this.bump();
    });
    await this.env.PUBLISHED.delete(
      channel.locales.map((locale) => paths.categories(DOC_FORMAT, code, locale)),
    );
    return channel;
  }

  channels(): Channel[] {
    return this.sql
      .exec<{ body: string }>('SELECT body FROM channels ORDER BY code')
      .toArray()
      .map((r) => JSON.parse(r.body) as Channel);
  }

  /** Upserts categories, refusing unknown parents and cycles, then republishes the tree. */
  async putCategories(inputs: CategoryInput[]): Promise<CategoriesResult> {
    const issues: string[] = [];
    const incoming: Category[] = [];
    for (const input of inputs) {
      const parsed = categorySchema.safeParse(input);
      if (parsed.success) incoming.push(parsed.data);
      else issues.push(...parsed.error.issues.map((i) => `${input.code}: ${i.message}`));
    }
    const all = new Map(this.listCategories().map((c) => [c.code, c]));
    for (const c of incoming) all.set(c.code, c);
    for (const c of incoming) {
      const seen = new Set<string>([c.code]);
      let parent = c.parent;
      while (parent) {
        if (!all.has(parent)) {
          issues.push(`${c.code}: unknown parent ${parent}`);
          break;
        }
        if (seen.has(parent)) {
          issues.push(`${c.code}: parent cycle through ${parent}`);
          break;
        }
        seen.add(parent);
        parent = all.get(parent)?.parent ?? null;
      }
    }
    if (issues.length) return { ok: false, issues };
    this.ctx.storage.transactionSync(() => {
      for (const c of incoming)
        this.sql.exec('INSERT OR REPLACE INTO categories VALUES (?, ?)', c.code, JSON.stringify(c));
    });
    await this.publishCategories(this.channels());
    return { ok: true, categories: incoming };
  }

  /**
   * Removes categories (the caller checked no product is filed in them) and republishes the
   * tree. Refused when a code is unknown or a category keeps children outside the set.
   */
  async deleteCategories(codes: string[]): Promise<DeleteResult<{ categories: Category[] }>> {
    const all = this.listCategories();
    const gone = new Set(codes);
    const issues: string[] = [];
    const unknown = [...gone].filter((code) => !all.some((c) => c.code === code));
    for (const code of unknown) issues.push(`${code}: unknown category`);
    for (const c of all)
      if (c.parent && gone.has(c.parent) && !gone.has(c.code))
        issues.push(`${c.parent}: still the parent of ${c.code}`);
    // Not found only when every problem is a code that doesn't exist.
    if (issues.length)
      return {
        ok: false,
        issues,
        ...(unknown.length === issues.length ? { notFound: true as const } : {}),
      };
    const deleted = all.filter((c) => gone.has(c.code));
    this.ctx.storage.transactionSync(() => {
      for (const code of gone) this.sql.exec('DELETE FROM categories WHERE code = ?', code);
    });
    await this.publishCategories(this.channels());
    return { ok: true, categories: deleted };
  }

  listCategories(): Category[] {
    return this.sql
      .exec<{ body: string }>('SELECT body FROM categories')
      .toArray()
      .map((r) => JSON.parse(r.body) as Category)
      .sort((a, b) => a.position - b.position || (a.code < b.code ? -1 : 1));
  }

  /** One flat, ordered tree document per channel and locale, names in that locale. */
  private async publishCategories(channels: Channel[]) {
    const categories = this.listCategories();
    await Promise.all(
      channels.flatMap((ch) =>
        ch.locales.map((locale) =>
          this.env.PUBLISHED.put(
            paths.categories(DOC_FORMAT, ch.code, locale),
            JSON.stringify({
              categories: categories.map((c) => ({
                code: c.code,
                parent: c.parent,
                name: pickLocale(c.name, locale, ch.defaultLocale) ?? c.code,
                slug: pickLocale(c.slug, locale, ch.defaultLocale),
                position: c.position,
              })),
            }),
            { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
          ),
        ),
      ),
    );
  }
}
