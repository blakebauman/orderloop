import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.ts'),
  layout('routes/shell.tsx', [
    index('routes/dashboard.tsx'),
    route('orders', 'routes/orders.tsx'),
    route('orders/new', 'routes/order-new.tsx'),
    route('orders/:orderId', 'routes/order.tsx'),
    route('flows', 'routes/flows.tsx'),
    route('flows/:flowId', 'routes/flow-editor.tsx'),
    route('approvals', 'routes/approvals.tsx'),
    route('back-office', 'routes/back-office.tsx'),
    route('team', 'routes/team.tsx'),
    route('account', 'routes/account.tsx'),
  ]),
  // Resource routes the editor and order page post to.
  route('flows/:flowId/action', 'routes/flow-action.ts'),
  route('orders/:orderId/action', 'routes/order-action.ts'),
] satisfies RouteConfig;
