import { describe, expect, it } from 'vitest';
import { conforms } from '../src/json-schema';

const extract = {
  type: 'object',
  properties: {
    customerName: { type: ['string', 'null'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { sku: { type: 'string' }, qty: { type: 'number' } },
        required: ['sku', 'qty'],
      },
    },
    route: { type: 'string', enum: ['auto_approve', 'review'] },
  },
  required: ['lines'],
};

describe('conforms', () => {
  it('accepts an answer that follows the schema', () => {
    expect(conforms({ customerName: null, lines: [{ sku: 'A', qty: 2 }] }, extract)).toBe(true);
  });

  it('refuses wrong types, missing fields and values outside an enum', () => {
    expect(conforms({ lines: 'A x2' }, extract)).toBe(false);
    expect(conforms({ lines: [{ sku: 'A', qty: '2' }] }, extract)).toBe(false);
    expect(conforms({ lines: [{ sku: 'A' }] }, extract)).toBe(false);
    expect(conforms({ customerName: 'Ada' }, extract)).toBe(false);
    expect(conforms({ lines: [], route: 'ship_free_tv' }, extract)).toBe(false);
    expect(conforms('{"lines":[]}', extract)).toBe(false);
  });
});
