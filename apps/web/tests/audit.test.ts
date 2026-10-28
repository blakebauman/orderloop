import { expect, it, describe as suite } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_GROUPS,
  actorLabel,
  describe,
  describeParts,
  isAuditGroup,
  targetHref,
} from '../app/lib/audit';

suite('audit vocabulary', () => {
  it('describes events in one line', () => {
    expect(
      describe({
        action: 'team.role_changed',
        actor: 'ops@example.com',
        target: 'ann@example.com',
        detail: { from: 'viewer', to: 'approver' },
      }),
    ).toBe('Changed a role: ann@example.com, Viewer → Approver');
    expect(
      describe({
        action: 'token.created',
        actor: 'ops',
        target: 'ERP sync',
        detail: { role: 'operator' },
      }),
    ).toBe('Created an API token: ERP sync, Operator');
    expect(
      describe({
        action: 'auth.sign_in_failed',
        actor: null,
        target: 'ann@example.com',
        detail: { reason: 'wrong email or password' },
      }),
    ).toBe('Sign-in failed: ann@example.com, wrong email or password');
    expect(
      describe({
        action: 'auth.sign_in',
        actor: 'ann@example.com',
        target: null,
        detail: { twoFactor: 'app' },
      }),
    ).toBe('Signed in: two-factor app');
    expect(
      describe({
        action: 'catalog.products_indexed',
        actor: 'ann@example.com',
        target: null,
        detail: { status: 'done', indexed: 3000, removed: 2, more: true },
      }),
    ).toBe('Updated the product index: 3000 added or renamed, 2 removed, more waiting');
    expect(
      describe({
        action: 'catalog.products_indexed',
        actor: 'ann@example.com',
        target: null,
        detail: { status: 'busy' },
      }),
    ).toBe('Updated the product index: skipped, another run was going');
    const ed = (action: string, detail: Record<string, unknown>) =>
      describe({ action, actor: 'ann@example.com', target: null, detail });
    expect(
      ed('catalog.edits_staged', { staged: 3, refused: 1, products: 1, fromDrafts: 2, via: 'api' }),
    ).toBe(
      'Staged catalog edits: 3 edits to 1 product, 2 from drafts, 1 refused, via the REST API',
    );
    expect(ed('catalog.edits_published', { published: 1, failed: 0, via: 'api' })).toBe(
      'Published catalog edits: 1 product, via the REST API',
    );
    expect(ed('catalog.drafts_discarded', { discarded: 4 })).toBe(
      'Discarded assistant drafts: 4 dropped',
    );
    expect(
      describe({
        action: 'auth.recovery_code_used',
        actor: 'ann@example.com',
        target: 'ann@example.com',
        detail: { left: 9 },
      }),
    ).toBe('Used a recovery code: ann@example.com, 9 left');
    expect(describe({ action: 'auth.sign_out', actor: 'ann', target: null, detail: null })).toBe(
      'Signed out',
    );
    expect(describe({ action: 'something.new', actor: null, target: null, detail: null })).toBe(
      'something.new',
    );
  });

  it('describes a plugin change by its version, publisher and grant', () => {
    expect(
      describe({
        action: 'plugin.approved',
        actor: 'usr_1',
        target: 'acme-carrier',
        detail: { version: '2', publisher: 'acme', personalData: true },
      }),
    ).toBe('Installed a plugin: acme-carrier, version 2, signed by acme, buyer details granted');
    expect(
      describe({
        action: 'plugin.secret_set',
        actor: 'usr_1',
        target: 'acme-carrier',
        detail: { secret: 'API_KEY' },
      }),
    ).toBe('Set a plugin’s secret: acme-carrier, API_KEY');
    expect(
      describe({
        action: 'plugin.drafted',
        actor: 'usr_1',
        target: 'ai-threshold',
        detail: { version: '2', via: 'assistant', cases: '2/2' },
      }),
    ).toBe(
      'The assistant drafted a plugin: ai-threshold, version 2, 2/2 cases pass, via the assistant',
    );
  });

  it('puts every action in a filter group', () => {
    for (const action of Object.keys(AUDIT_ACTIONS))
      expect(isAuditGroup(action.slice(0, action.indexOf('.')))).toBe(true);
    expect(Object.keys(AUDIT_GROUPS)).toEqual([
      'auth',
      'team',
      'token',
      'scim',
      'api',
      'oauth',
      'integration',
      'ucp',
      'order',
      'approval',
      'cart',
      'flow',
      'webhook',
      'stock',
      'promotion',
      'tax_certificate',
      'catalog',
      'plugin',
      'personal_data',
    ]);
    expect(isAuditGroup('orders')).toBe(false);
  });
});

suite('audit actors and targets', () => {
  it('names an API token by its name, not its principal id', () => {
    expect(actorLabel({ actor: 'token:Local seed scripts', actorKind: 'token' })).toBe(
      'Local seed scripts (API token)',
    );
    expect(actorLabel({ actor: 'ann@example.com', actorKind: 'user' })).toBe('ann@example.com');
    expect(actorLabel({ actor: null })).toBeNull();
  });

  it('links what an event acted on when the app has a page for it', () => {
    expect(targetHref({ action: 'cart.created', target: 'cart_mv65gsxyqcs34m' })).toBe(
      '/carts/cart_mv65gsxyqcs34m',
    );
    expect(targetHref({ action: 'order.cancelled', target: 'ord_abc123' })).toBe(
      '/orders/ord_abc123',
    );
    expect(targetHref({ action: 'flow.published', target: 'tpl-storefront-order' })).toBe(
      '/flows/tpl-storefront-order',
    );
    expect(targetHref({ action: 'team.user_added', target: 'ann@example.com' })).toBeNull();
    expect(targetHref({ action: 'order.started', target: null })).toBeNull();
  });

  it('splits a description so its target can be linked, in the order describe reads', () => {
    const e = {
      action: 'cart.canceled',
      actor: 'token:Local seed scripts',
      target: 'cart_x1',
      detail: { via: 'api' },
    };
    expect(describeParts(e)).toEqual({
      label: 'Cancelled a cart',
      target: 'cart_x1',
      details: ['via the REST API'],
    });
    expect(describe(e)).toBe('Cancelled a cart: cart_x1, via the REST API');
  });

  it('counts what disabling a person ended in words', () => {
    expect(
      describe({
        action: 'team.user_disabled',
        actor: 'ops@example.com',
        target: 'ann@example.com',
        detail: { sessions: 1, apps: 0, tokens: 2 },
      }),
    ).toBe('Disabled a person: ann@example.com, 1 session, 0 apps and 2 tokens ended');
  });
});
