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
 *   GET  /api/v1/catalog/channels  POST …        channels
 *   GET  /api/v1/catalog/categories  POST …      { categories: [...] }
 *   POST /api/v1/catalog/feeds?format=csv|ndjson&name=…   the file as the body; 202 and its status
 *   GET  /api/v1/catalog/feeds                   recent feeds;  GET …/feeds/:id  one feed
 *   POST /api/v1/catalog/reindex                 republish everything (admin)
 */
import { atLeast, type Principal, type Role } from '@orderloop/core';
import { FEED_FORMATS, type FeedFormat } from '@orderloop/core/product';
import {
  catalogCategoriesInput,
  catalogChannelInput,
  catalogDeleteInput,
  catalogProductsInput,
  catalogTypeInput,
} from './api-schemas';
import { audit } from './audit.server';
import { forbidden } from './auth.server';
import { readText } from './body';
import { catalog } from './env.server';

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
      const feed = await c.startFeed(request.body, { name, format, by });
      await audit(request, 'catalog.feed_started', {
        actor: caller,
        target: feed.id,
        detail: { name, format, via: 'api' },
      });
      return json({ feed }, 202);
    }
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
