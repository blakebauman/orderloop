/**
 * The product catalog Worker. No public routes: the web app and catalog-edge reach it through the
 * CatalogApi entrypoint over service bindings.
 */
export { CatalogApi } from './api';
export { CatalogMeta } from './meta';
export { CatalogShard } from './shard';

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
