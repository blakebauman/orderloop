import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('login/two-factor', 'routes/login-two-factor.tsx'),
  route('login/passkey', 'routes/login-passkey.ts'),
  // Single sign-on with the workspace's identity provider (lib/sso.server.ts).
  route('login/sso', 'routes/login-sso.ts'),
  route('login/sso/callback', 'routes/login-sso-callback.ts'),
  route('logout', 'routes/logout.ts'),
  // A new deployment's first admin, from its one-time setup code (lib/setup.server.ts).
  route('setup', 'routes/setup.tsx'),
  // The consent page MCP clients send people to (lib/oauth.server.ts).
  route('oauth/authorize', 'routes/oauth-authorize.tsx'),
  layout('routes/shell.tsx', [
    // An error boundary inside the shell, so a refused or missing page keeps the app around it.
    layout('routes/in-app.tsx', [
      index('routes/dashboard.tsx'),
      route('orders', 'routes/orders.tsx'),
      route('orders/new', 'routes/order-new.tsx'),
      // Demo data only: one-click scenarios, some with a simulated failure.
      route('orders/scenarios', 'routes/order-scenarios.tsx'),
      route('orders/:orderId', 'routes/order.tsx'),
      route('flows', 'routes/flows.tsx'),
      route('flows/:flowId', 'routes/flow-editor.tsx'),
      route('approvals', 'routes/approvals.tsx'),
      route('back-office', 'routes/back-office.tsx'),
      route('team', 'routes/team.tsx'),
      route('audit', 'routes/audit.tsx'),
      route('account', 'routes/account.tsx'),
    ]),
  ]),
  // Resource routes the editor and order page post to.
  route('flows/:flowId/action', 'routes/flow-action.ts'),
  route('orders/:orderId/action', 'routes/order-action.ts'),
  route('account/passkeys', 'routes/account-passkeys.ts'),
] satisfies RouteConfig;
