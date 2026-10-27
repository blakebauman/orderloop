/**
 * /api/v1/catalog: the product catalog's admin API, forwarded to the catalog Worker over its
 * service binding (`ProductCatalogRpc`). Reads need viewer, writes operator, reindex admin. Every
 * write is in the audit log. What shoppers read is served by catalog-edge, not here.
 *
 *   GET  /api/v1/catalog/products/:key           the stored product
 *   POST /api/v1/catalog/products                { products: [...], urgent? }  at most 500
 *   POST /api/v1/catalog/products/delete         { keys: [...], urgent? }
 *   GET  /api/v1/catalog/aliases/:alias          which product holds a SKU, GTIN or slug
 *   GET  /api/v1/catalog/types                   latest version of each type
 *   POST /api/v1/catalog/types                   a type, or its next (additive) version
 *   DELETE /api/v1/catalog/types/:code           every version; 409 while products use it
 *   GET  /api/v1/catalog/channels  POST …        channels
 *   DELETE /api/v1/catalog/channels/:code        takes down all it published (admin)
 *   GET  /api/v1/catalog/categories  POST …      { categories: [...] }
 *   POST /api/v1/catalog/categories/delete       { codes }; 409 while one has children or products
 *   POST /api/v1/catalog/feeds?format=csv|ndjson&name=…   the file as the body; 202 and its status
 *   GET  /api/v1/catalog/feeds                   recent feeds;  GET …/feeds/:id  one feed
 *   POST /api/v1/catalog/feeds/:id/cancel        stops a feed; 409 once it has finished
 *   POST /api/v1/catalog/reindex                 republish everything (admin)
 *
 * The product editor (docs/product-editor.md):
 *   GET  /api/v1/catalog/board                   counts per column and gap kind, latest feeds
 *   GET  /api/v1/catalog/board/:column?kind=&cursor=&limit=   one column's cards
 *   GET  /api/v1/catalog/products/:key/sheet     live and feed versions, edits, drafts, history
 *   POST /api/v1/catalog/edits                   { edits }   stage, at most 500
 *   POST /api/v1/catalog/edits/discard           { items }   drop staged edits
 *   POST /api/v1/catalog/edits/publish           { keys, requestId?, urgent? }   at most 500
 *   POST /api/v1/catalog/drafts                  { drafts }  assistant drafts, at most 500
 *   POST /api/v1/catalog/drafts/discard          { items }
 *   POST /api/v1/catalog/gaps/rebuild            recount every product's gaps (admin)
 */
import { atLeast, type Principal, type Role } from '@orderloop/core';
import {
  BOARD_COLUMNS,
  type BoardColumn,
  FEED_FORMATS,
  type FeedFormat,
  GAP_KINDS,
  type GapKind,
} from '@orderloop/core/product';
import {
  catalogCategoriesDeleteInput,
  catalogCategoriesInput,
  catalogChannelInput,
  catalogDeleteInput,
  catalogDiscardInput,
  catalogDraftsInput,
  catalogEditsInput,
  catalogProductsInput,
  catalogPublishInput,
  catalogTypeInput,
} from './api-schemas';
import { audit } from './audit.server';
import { forbidden } from './auth.server';
import { readText } from './body';
import { afterResponse, catalog } from './env.server';

const json = (data: unknown, status = 200) => Response.json(data, { status });
/** Up to 500 products a call: allow a few kilobytes each. */
const MAX_PRODUCTS_BYTES = 8 * 1024 * 1024;

async function readJson(request: Request, limit?: number): Promise<unknown> {
  try {
    return JSON.parse(await readText(request, limit));
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

const invalid = (what: string, issues: unknown) => json({ error: `Invalid ${what}`, issues }, 400);

/** A refused delete: 404 when there was nothing to delete, 409 when something still depends on it. */
const refusedDelete = (what: string, r: { issues: string[]; notFound?: true }) =>
  r.notFound
    ? json({ error: 'Not found', issues: r.issues }, 404)
    : json({ error: `${what} is in use`, issues: r.issues }, 409);

export async function handleCatalog(
  request: Request,
  caller: Principal,
  parts: string[],
): Promise<Response> {
  const need = (min: Role) =>
    atLeast(caller.role, min) ? null : json({ error: forbidden(min) }, 403);
  const c = catalog();
  const by = caller.email ?? caller.id;
  const [, section, id, sub] = parts;
  const get = request.method === 'GET';
  const post = request.method === 'POST';

  if (section === 'products') {
    if (get && id && sub === 'sheet') {
      const blocked = need('viewer');
      if (blocked) return blocked;
      const sheet = await c.getProductSheet(id);
      return sheet ? json({ sheet }) : json({ error: 'Not found' }, 404);
    }
    if (get && id && !sub) {
      const blocked = need('viewer');
      if (blocked) return blocked;
      const product = await c.getProduct(id);
      return product ? json({ product }) : json({ error: 'Not found' }, 404);
    }
    if (post && !id) {
      const blocked = need('operator');
      if (blocked) return blocked;
      const parsed = catalogProductsInput.safeParse(await readJson(request, MAX_PRODUCTS_BYTES));
      if (!parsed.success) return invalid('products', parsed.error.issues);
      const results = await c.putProducts(parsed.data.products, { by, urgent: parsed.data.urgent });
      const count = (s: string) => results.filter((r) => r.status === s).length;
      await audit(request, 'catalog.products_written', {
        actor: caller,
        detail: {
          created: count('created'),
          updated: count('updated'),
          unchanged: count('unchanged'),
          rejected: count('rejected'),
          urgent: parsed.data.urgent ?? false,
          via: 'api',
        },
      });
      return json({ results });
    }
    if (post && id === 'delete' && !sub) {
      const blocked = need('operator');
      if (blocked) return blocked;
      const parsed = catalogDeleteInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('delete', parsed.error.issues);
      const results = await c.deleteProducts(parsed.data.keys, { by, urgent: parsed.data.urgent });
      await audit(request, 'catalog.products_deleted', {
        actor: caller,
        detail: { deleted: results.filter((r) => r.status === 'deleted').length, via: 'api' },
      });
      return json({ results });
    }
  }

  if (section === 'aliases' && get && id && !sub) {
    const blocked = need('viewer');
    if (blocked) return blocked;
    const key = await c.resolveAlias(id);
    return key ? json({ key }) : json({ error: 'Not found' }, 404);
  }

  if (section === 'types' && !id) {
    if (get) return need('viewer') ?? json({ types: await c.listTypes() });
    if (post) {
      const blocked = need('operator');
      if (blocked) return blocked;
      const parsed = catalogTypeInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('product type', parsed.error.issues);
      const r = await c.putType(parsed.data, by);
      if (!r.ok) return json({ error: 'Type refused', issues: r.issues }, 409);
      await audit(request, 'catalog.type_saved', {
        actor: caller,
        target: r.type.code,
        detail: { version: r.type.version, via: 'api' },
      });
      return json({ type: r.type }, 201);
    }
  }

  if (section === 'types' && id && !sub && request.method === 'DELETE') {
    const blocked = need('operator');
    if (blocked) return blocked;
    const r = await c.deleteType(id, by);
    if (!r.ok) return refusedDelete('The type', r);
    await audit(request, 'catalog.type_deleted', {
      actor: caller,
      target: id,
      detail: { versions: r.versions, via: 'api' },
    });
    return json(r);
  }

  if (section === 'channels' && id && !sub && request.method === 'DELETE') {
    // Takes a storefront's whole catalog down: admin only.
    const blocked = need('admin');
    if (blocked) return blocked;
    const r = await c.deleteChannel(id, by);
    if (!r.ok) return refusedDelete('The channel', r);
    await audit(request, 'catalog.channel_deleted', {
      actor: caller,
      target: id,
      detail: { unpublished: r.unpublished, via: 'api' },
    });
    return json(r);
  }

  if (section === 'categories' && id === 'delete' && !sub && post) {
    const blocked = need('operator');
    if (blocked) return blocked;
    const parsed = catalogCategoriesDeleteInput.safeParse(await readJson(request));
    if (!parsed.success) return invalid('delete', parsed.error.issues);
    const r = await c.deleteCategories(parsed.data.codes, by);
    if (!r.ok) return refusedDelete('A category', r);
    await audit(request, 'catalog.categories_deleted', {
      actor: caller,
      detail: { codes: r.deleted, via: 'api' },
    });
    return json(r);
  }

  if (section === 'channels' && !id) {
    if (get) return need('viewer') ?? json({ channels: await c.listChannels() });
    if (post) {
      const blocked = need('operator');
      if (blocked) return blocked;
      const parsed = catalogChannelInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('channel', parsed.error.issues);
      const r = await c.putChannel(parsed.data, by);
      if (!r.ok) return json({ error: 'Channel refused', issues: r.issues }, 400);
      await audit(request, 'catalog.channel_saved', {
        actor: caller,
        target: r.channel.code,
        detail: { via: 'api' },
      });
      return json({ channel: r.channel });
    }
  }

  if (section === 'categories' && !id) {
    if (get) return need('viewer') ?? json({ categories: await c.listCategories() });
    if (post) {
      const blocked = need('operator');
      if (blocked) return blocked;
      const parsed = catalogCategoriesInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('categories', parsed.error.issues);
      const r = await c.putCategories(parsed.data.categories, by);
      if (!r.ok) return json({ error: 'Categories refused', issues: r.issues }, 400);
      await audit(request, 'catalog.categories_saved', {
        actor: caller,
        detail: { count: r.categories.length, via: 'api' },
      });
      return json({ categories: r.categories });
    }
  }

  if (section === 'feeds') {
    if (get && !id) {
      const limit = Number(new URL(request.url).searchParams.get('limit') ?? 20);
      return (
        need('viewer') ?? json({ feeds: await c.listFeeds(Number.isFinite(limit) ? limit : 20) })
      );
    }
    if (get && id && !sub) {
      const blocked = need('viewer');
      if (blocked) return blocked;
      const feed = await c.feedStatus(id);
      return feed ? json({ feed }) : json({ error: 'Not found' }, 404);
    }
    if (post && id && sub === 'cancel') {
      const blocked = need('operator');
      if (blocked) return blocked;
      const feed = await c.cancelFeed(id, by);
      if (!feed) return json({ error: 'Not found' }, 404);
      if (feed.state !== 'cancelled')
        return json({ error: `The feed has already finished (${feed.state})`, feed }, 409);
      await audit(request, 'catalog.feed_cancelled', {
        actor: caller,
        target: id,
        detail: { via: 'api' },
      });
      return json({ feed });
    }
    if (post && !id) {
      const blocked = need('operator');
      if (blocked) return blocked;
      const q = new URL(request.url).searchParams;
      const format = q.get('format') as FeedFormat | null;
      if (!format || !FEED_FORMATS.includes(format))
        return json({ error: `format must be ${FEED_FORMATS.join(' or ')}` }, 400);
      if (!request.body) return json({ error: 'The feed file is the request body' }, 400);
      const name = (q.get('name') ?? `feed.${format}`).slice(0, 200);
      // Streamed to the catalog as it arrives: a feed of any size never sits in this Worker.
      const started = c.startFeed(request.body, { name, format, by });
      // The catalog finishes starting a stored feed even if this caller goes, so it's audited
      // after the response too.
      afterResponse(
        started.then(
          (feed) =>
            audit(request, 'catalog.feed_started', {
              actor: caller,
              target: feed.id,
              detail: { name, format, via: 'api' },
            }),
          () => {},
        ),
      );
      let feed: Awaited<typeof started>;
      try {
        feed = await started;
      } catch (err) {
        // The catalog gave up on a body that stopped arriving: nothing was stored, send it again.
        if (err instanceof Error && err.message.startsWith('upload stalled'))
          return json(
            { error: 'The feed stopped arriving; nothing was stored. Send it again.' },
            408,
          );
        throw err;
      }
      return json({ feed }, 202);
    }
  }

  if (section === 'board' && get && !sub) {
    const blocked = need('viewer');
    if (blocked) return blocked;
    if (!id) return json({ board: await c.catalogBoard() });
    if (!(BOARD_COLUMNS as readonly string[]).includes(id))
      return json({ error: `No column ${id}: one of ${BOARD_COLUMNS.join(', ')}` }, 404);
    const q = new URL(request.url).searchParams;
    const kind = q.get('kind');
    if (kind && !(GAP_KINDS as readonly string[]).includes(kind))
      return json({ error: `kind must be one of ${GAP_KINDS.join(', ')}` }, 400);
    const limit = q.get('limit');
    return json(
      await c.listBoard({
        column: id as BoardColumn,
        kind: (kind as GapKind | null) ?? undefined,
        cursor: q.get('cursor') ?? undefined,
        limit: limit === null ? undefined : Number(limit),
      }),
    );
  }

  if (section === 'edits' && post && !sub) {
    const blocked = need('operator');
    if (blocked) return blocked;
    if (!id) {
      const parsed = catalogEditsInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('edits', parsed.error.issues);
      const results = await c.stageEdits(parsed.data.edits, by);
      const staged = results.filter((r) => r.ok);
      await audit(request, 'catalog.edits_staged', {
        actor: caller,
        detail: {
          staged: staged.length,
          refused: results.length - staged.length,
          products: new Set(staged.map((r) => r.key)).size,
          fromDrafts: parsed.data.edits.filter((e, i) => e.source === 'assistant' && results[i]?.ok)
            .length,
          via: 'api',
        },
      });
      return json({ results });
    }
    if (id === 'discard') {
      const parsed = catalogDiscardInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('discard', parsed.error.issues);
      const r = await c.discardStaged(parsed.data.items, by);
      await audit(request, 'catalog.edits_discarded', {
        actor: caller,
        detail: { discarded: r.discarded, via: 'api' },
      });
      return json(r);
    }
    if (id === 'publish') {
      const parsed = catalogPublishInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('publish', parsed.error.issues);
      const requestId = parsed.data.requestId ?? crypto.randomUUID();
      const results = await c.publishStaged(parsed.data.keys, {
        by,
        requestId,
        urgent: parsed.data.urgent,
      });
      const count = (s: string) => results.filter((r) => r.status === s).length;
      await audit(request, 'catalog.edits_published', {
        actor: caller,
        detail: {
          published: count('published'),
          failed: count('failed'),
          unchanged: count('unchanged'),
          keys: results
            .filter((r) => r.status === 'published')
            .map((r) => r.key)
            .slice(0, 50),
          requestId,
          urgent: parsed.data.urgent ?? false,
          via: 'api',
        },
      });
      return json({ requestId, results });
    }
  }

  if (section === 'drafts' && post && !sub) {
    const blocked = need('operator');
    if (blocked) return blocked;
    if (!id) {
      const parsed = catalogDraftsInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('drafts', parsed.error.issues);
      const results = await c.putDrafts(parsed.data.drafts, by);
      const saved = results.filter((r) => r.ok).length;
      await audit(request, 'catalog.drafts_saved', {
        actor: caller,
        detail: { saved, refused: results.length - saved, via: 'api' },
      });
      return json({ results });
    }
    if (id === 'discard') {
      const parsed = catalogDiscardInput.safeParse(await readJson(request));
      if (!parsed.success) return invalid('discard', parsed.error.issues);
      const r = await c.discardDrafts(parsed.data.items, by);
      await audit(request, 'catalog.drafts_discarded', {
        actor: caller,
        detail: { discarded: r.discarded, via: 'api' },
      });
      return json(r);
    }
  }

  if (section === 'gaps' && id === 'rebuild' && post && !sub) {
    // Reads every product in the catalog: admin only.
    const blocked = need('admin');
    if (blocked) return blocked;
    const r = await c.rebuildGaps(by);
    await audit(request, 'catalog.gaps_rebuilt', {
      actor: caller,
      detail: { products: r.products, via: 'api' },
    });
    return json(r);
  }

  if (section === 'reindex' && post && !id) {
    const blocked = need('admin');
    if (blocked) return blocked;
    const r = await c.reindex(by);
    await audit(request, 'catalog.reindexed', {
      actor: caller,
      detail: { queued: r.queued, via: 'api' },
    });
    return json(r, 202);
  }

  return json({ error: 'Not found' }, 404);
}
