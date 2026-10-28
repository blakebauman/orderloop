/**
 * orderloop-engine. No public routes: the web app reaches it through a service binding, as RPC
 * (`EngineApi`) or plain fetch for the health check, the agent WebSockets it proxies, MCP
 * (`/mcp`, see ./mcp.ts), A2A (`/a2a`, see ./a2a/) and UCP (`/ucp/*`, see ./ucp/).
 * Cloudflare Email Routing delivers inbound order email to `email()` (see ./email.ts).
 */

import { UCP_PATH } from '@orderloop/core';
import { A2A_PATH, handleA2A } from './a2a/route';
import { routeAgents } from './agent-routes';
import { retryLabelVoids } from './connectors';
import { receiveEmail } from './email';
import { handleMcp, MCP_PATH } from './mcp';
import { reindexProducts } from './product-index';
import { sweep } from './retention';
import { handleUcp } from './ucp/rest';

export { A2AAgent } from './a2a/agent';
export { OrderAgent } from './agent';
export { EngineApi } from './api';
export { AssistantAgent } from './assistant/agent';
export { CartAgent } from './cart/agent';
// The deploy smoke test's write check object (health.ts).
export { HealthProbe } from './health';
// What a plugin can ask of the core, bound into it as ORDERLOOP (plugin-api.ts).
export { PluginHost } from './plugin-api';
// The sandbox's capabilities, reached as `ctx.exports` by the plugins it loads (plugin-host.ts).
export {
  PluginDb,
  PluginEgress,
  PluginSecrets,
  PluginStorage,
  PluginTail,
} from './plugin-host';
export { DryRunSecrets } from './plugin-installs';
export { Replenish } from './replenish';
export { OrderLoop } from './workflow';

/** The hourly cron in wrangler.jsonc that runs `reindexProducts`. */
const REINDEX_CRON = '15 * * * *';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'orderloop-engine' });
    if (url.pathname === MCP_PATH) return handleMcp(request);
    if (url.pathname === A2A_PATH) return handleA2A(request, env);
    if (url.pathname === UCP_PATH || url.pathname.startsWith(`${UCP_PATH}/`))
      return handleUcp(request, env);
    return routeAgents(request, env);
  },

  // `triggers.crons` in wrangler.jsonc: hourly, the product index catches up with `products`;
  // daily, the retention sweep and another try at labels a provider couldn't void.
  async scheduled(controller, env) {
    if (controller.cron === REINDEX_CRON) {
      await reindexProducts(env);
      return;
    }
    console.log('retention sweep', JSON.stringify(await sweep(env)));
    console.log('label voids', JSON.stringify(await retryLabelVoids(env)));
  },

  async email(message, env) {
    try {
      const outcome = await receiveEmail(message, env);
      console.log('email intake', JSON.stringify({ to: message.to, ...outcome }));
    } catch (err) {
      // Thrown on, so Email Routing answers with a temporary failure and the sender retries.
      console.error('email intake failed', JSON.stringify({ to: message.to }), err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
