import { describe, expect, it } from 'vitest';
import {
  applyLines,
  CHECKOUT_TTL_MS,
  type CheckoutQuote,
  type CheckoutSession,
  checkoutFlowProblem,
  isExpired,
  isOpenCheckout,
  LOOP_INPUT,
  missingInfo,
  openStatus,
  patchCheckout,
  quoteNodes,
  storefrontOrderFlow,
} from '../src';

const quote = (q: Partial<CheckoutQuote> = {}): CheckoutQuote => ({
  currency: 'USD',
  lines: [],
  subtotal: 10,
  shipping: 0,
  tax: 0,
  total: 10,
  shippingOptions: [],
  shippingOption: null,
  ships: false,
  ...q,
});

const session = (s: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'chk_1',
  ownerId: 'ucp_1',
  status: 'incomplete',
  currency: 'USD',
  lines: [{ id: 'li_1', sku: 'SKU-1', qty: 1 }],
  buyer: { email: 'ada@example.com' },
  fulfillment: 'ship',
  shipTo: null,
  shippingOption: null,
  quote: quote(),
  issues: [],
  orderId: null,
  createdAt: 0,
  updatedAt: 0,
  expiresAt: CHECKOUT_TTL_MS,
  version: 1,
  ...s,
});

const address = { line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' };

describe('applyLines', () => {
  it('numbers new lines and keeps the ids of lines it is given back', () => {
    const first = applyLines(
      [],
      [
        { sku: 'A', qty: 1 },
        { sku: 'B', qty: 2 },
      ],
    );
    expect(first.map((l) => l.id)).toEqual(['li_1', 'li_2']);
    const next = applyLines(first, [
      { id: 'li_2', sku: 'B', qty: 5 },
      { sku: 'C', qty: 1 },
    ]);
    expect(next).toEqual([
      { id: 'li_2', sku: 'B', qty: 5 },
      { id: 'li_3', sku: 'C', qty: 1 },
    ]);
  });

  it('treats an unknown id as a new line', () => {
    expect(applyLines([], [{ id: 'li_9', sku: 'A', qty: 1 }])[0]!.id).toBe('li_1');
  });
});

describe('patchCheckout', () => {
  it('replaces only what the patch names', () => {
    const s = patchCheckout(session({ shippingOption: 'express' }), { buyer: { email: 'b@x.co' } });
    expect(s.buyer).toEqual({ email: 'b@x.co' });
    expect(s.shippingOption).toBe('express');
    expect(s.lines).toHaveLength(1);
    expect(patchCheckout(s, { shippingOption: null }).shippingOption).toBeNull();
  });
});

describe('missingInfo and openStatus', () => {
  it('is ready when a digital order has lines and an email', () => {
    const s = session();
    expect(missingInfo(s)).toEqual([]);
    expect(openStatus(missingInfo(s))).toBe('ready_for_complete');
  });

  it('asks for lines and an email', () => {
    const issues = missingInfo(session({ lines: [], buyer: {} }));
    expect(issues.map((i) => i.path)).toEqual(['$.line_items', '$.buyer.email']);
    expect(issues.every((i) => i.severity === 'recoverable')).toBe(true);
    expect(openStatus(issues)).toBe('incomplete');
  });

  it('asks for an address, and an option when the flow picked none, for goods that ship', () => {
    const options = [
      { id: 'standard', title: 'Standard', carrier: 'ups', amount: 5, minDays: 3, maxDays: 5 },
      { id: 'express', title: 'Express', carrier: 'fedex', amount: 15, minDays: 1, maxDays: 2 },
    ];
    const ships = quote({ ships: true, shippingOptions: options });
    expect(missingInfo(session({ quote: ships })).map((i) => i.content)).toEqual([
      'A complete shipping address is required.',
      'Choose a shipping option.',
    ]);
    expect(
      missingInfo(session({ quote: ships, shipTo: address, shippingOption: 'express' })),
    ).toEqual([]);
    // The flow's own pick counts as a choice.
    const picked = quote({ ships: true, shippingOptions: options, shippingOption: 'standard' });
    expect(missingInfo(session({ quote: picked, shipTo: address }))).toEqual([]);
  });

  it('escalates on an error only a person can clear, and ignores warnings', () => {
    expect(
      openStatus([
        { kind: 'error', code: 'missing', content: 'x', severity: 'recoverable' },
        { kind: 'error', code: 'age', content: 'y', severity: 'requires_buyer_review' },
      ]),
    ).toBe('requires_escalation');
    expect(openStatus([{ kind: 'warning', code: 'final_sale', content: 'z' }])).toBe(
      'ready_for_complete',
    );
  });
});

describe('isOpenCheckout and isExpired', () => {
  it('closes completing, completed and canceled sessions', () => {
    expect(isOpenCheckout(session({ status: 'ready_for_complete' }))).toBe(true);
    for (const status of ['complete_in_progress', 'completed', 'canceled'] as const)
      expect(isOpenCheckout(session({ status }))).toBe(false);
  });

  it('expires only open sessions past their time', () => {
    expect(isExpired(session({ expiresAt: 100 }), 100)).toBe(true);
    expect(isExpired(session({ expiresAt: 100 }), 99)).toBe(false);
    expect(isExpired(session({ expiresAt: 100, status: 'completed' }), 200)).toBe(false);
  });
});

describe('quoteNodes', () => {
  it("takes the storefront flow's pricing and policy nodes in the order it runs them", () => {
    expect(quoteNodes(storefrontOrderFlow()).map((n) => n.type)).toEqual([
      'commerce.validate',
      'commerce.price',
      'commerce.shipping_rate',
      'commerce.discount',
      'commerce.tax',
      'commerce.policy',
    ]);
  });

  it('orders by the graph, not the node list, and ignores loop back-edges', () => {
    const node = (id: string, type: string) => ({
      id,
      type,
      label: id,
      config: {},
      position: { x: 0, y: 0 },
    });
    const graph = {
      nodes: [
        node('tax', 'commerce.tax'),
        node('price', 'commerce.price'),
        node('start', 'trigger.manual'),
        node('again', 'control.loop'),
      ],
      edges: [
        { id: 'a', source: 'start', target: 'price' },
        { id: 'b', source: 'price', target: 'again' },
        { id: 'c', source: 'again', target: 'tax' },
        { id: 'd', source: 'tax', target: 'again', targetHandle: LOOP_INPUT },
      ],
    };
    expect(quoteNodes(graph).map((n) => n.id)).toEqual(['price', 'tax']);
  });
});

describe('checkoutFlowProblem', () => {
  it('accepts the storefront flow', () => {
    expect(checkoutFlowProblem(storefrontOrderFlow())).toBeNull();
  });

  it('refuses a flow that never holds a card payment', () => {
    expect(checkoutFlowProblem({ nodes: [], edges: [] })).toMatch(/authorize/);
    const terms = storefrontOrderFlow();
    const auth = terms.nodes.find((n) => n.type === 'commerce.authorize_payment')!;
    auth.config = { ...auth.config, method: 'terms' };
    expect(checkoutFlowProblem(terms)).toMatch(/terms/);
    auth.config = { method: 'card', purpose: 'verify' };
    expect(checkoutFlowProblem(terms)).toMatch(/verifies/);
  });
});
