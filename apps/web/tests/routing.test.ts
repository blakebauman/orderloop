import { describe, expect, it } from 'vitest';
import { receives } from '../app/lib/routing';

const boxes = { orders: 'tpl-b2b-order', po: 'tpl-b2b-order', purchasing: 'tpl-purchase-request' };

describe('receives', () => {
  it('names a model default, its mailboxes, and the channels routed elsewhere', () => {
    expect(receives({ id: 'tpl-b2b-order', model: 'b2b' }, {}, boxes)).toEqual({
      lines: ['B2B, any channel (default)', 'Email to orders@', 'Email to po@'],
      isDefault: true,
    });
    // POS is routed to the till flow by default, so the storefront gets the other channels.
    expect(receives({ id: 'tpl-storefront-order', model: 'b2c' }, {}, {}).lines).toEqual([
      'B2C retail, other channels (default)',
    ]);
    expect(receives({ id: 'tpl-pos-sale', model: 'b2c' }, {}, {}).lines).toEqual([
      'B2C retail, Point of sale',
      'Direct to consumer, Point of sale',
    ]);
  });

  it('follows ORDER_ROUTES, which can take a default away', () => {
    const routes = { 'marketplace:*': 'flow-market-v2', 'b2c:web': 'flow-flash' };
    expect(receives({ id: 'tpl-marketplace-order', model: 'marketplace' }, routes, {})).toEqual({
      lines: [],
      isDefault: false,
    });
    expect(receives({ id: 'flow-market-v2', model: 'marketplace' }, routes, {}).lines).toEqual([
      'Marketplace, any channel',
    ]);
    expect(receives({ id: 'flow-flash', model: 'b2c' }, routes, {}).lines).toEqual([
      'B2C retail, Web',
    ]);
  });
});
