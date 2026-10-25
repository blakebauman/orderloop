import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('login/two-factor', 'routes/login-two-factor.tsx'),
  route('login/passkey', 'routes/login-passkey.ts'),
  // Single sign-on with the workspace's identity provider (lib/sso.server.ts).
  route('login/sso', 'routes/login-sso.ts'),
  route('login/sso/callback', 'routes/login-sso-callback.ts'),
  route('login/sso/link', 'routes/login-sso-link.tsx'),
  route('logout', 'routes/logout.tsx'),
  // A new deployment's first admin, from its one-time setup code (lib/setup.server.ts).
  route('setup', 'routes/setup.tsx'),
  // The consent page MCP clients send people to (lib/oauth.server.ts).
  route('oauth/authorize', 'routes/oauth-authorize.tsx'),
  // An external cart's buyer (a punchout session): a one-time start link, then the cart itself,
  // outside the app shell and its sign-in (lib/cart-guest.server.ts).
  route('cart/start/:cartId/:token', 'routes/cart-start.tsx'),
  route('cart/:cartId', 'routes/cart-buy.tsx'),
  // A cart's files, for staff or the cart's buyer (lib/cart-attachments.server.ts).
  route('carts/:cartId/attachments', 'routes/cart-attachments.ts'),
  route('carts/:cartId/attachments/:attachmentId', 'routes/cart-attachment.ts'),
  layout('routes/shell.tsx', [
    // An error boundary inside the shell, so a refused or missing page keeps the app around it.
    layout('routes/in-app.tsx', [
      index('routes/dashboard.tsx'),
      route('orders', 'routes/orders.tsx'),
      route('orders/new', 'routes/order-new.tsx'),
      // Demo data only: one-click scenarios, some with a simulated failure.
      route('orders/scenarios', 'routes/order-scenarios.tsx'),
      route('orders/:orderId', 'routes/order.tsx'),
      route('carts', 'routes/carts.tsx'),
      route('carts/:cartId', 'routes/cart.tsx'),
      route('flows', 'routes/flows.tsx'),
      route('flows/:flowId', 'routes/flow-editor.tsx'),
      route('approvals', 'routes/approvals.tsx'),
      route('commerce', 'routes/commerce.tsx'),
      route('promotions', 'routes/promotions.tsx'),
      route('team', 'routes/team.tsx'),
      route('audit', 'routes/audit.tsx'),
      // Installed plugins (admin). Their own pages are under /plugins/<id>/, forwarded by workers/app.ts.
      route('plugins', 'routes/plugins.tsx'),
      // A plugin's page drawn by the app, from the view it answered with (workers/app.ts).
      route('plugins/:pluginId/*', 'routes/plugin-page.tsx'),
      route('account', 'routes/account.tsx'),
    ]),
  ]),
  // Resource routes the editor and order page post to.
  route('flows/:flowId/action', 'routes/flow-action.ts'),
  route('orders/:orderId/action', 'routes/order-action.ts'),
  route('orders/:orderId/records', 'routes/order-records.ts'),
  route('account/passkeys', 'routes/account-passkeys.ts'),
] satisfies RouteConfig;
