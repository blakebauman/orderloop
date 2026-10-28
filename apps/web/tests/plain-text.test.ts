import { describe, expect, it } from 'vitest';
import { eventName, plainLog, plainVars, readableReason } from '../app/lib/format';

const sqlError = `Failed query: select "sku", "name", "cost" from "products" where "products"."sku" in (?, ?)\nparams: WID-100,GSK-010`;

describe('readableReason', () => {
  it('names where a stored database error happened, never its statement', () => {
    expect(readableReason(`Supplier cost: ${sqlError}`)).toBe('Database error at Supplier cost');
    expect(readableReason(sqlError)).toBe('Database error');
    expect(readableReason('Reserve stock: D1_ERROR: too many SQL variables')).toBe(
      'Database error at Reserve stock',
    );
    expect(readableReason('Ship: SQLITE_BUSY')).toBe('Database error at Ship');
  });

  it('leaves any other reason as written, on one line', () => {
    expect(readableReason('Insufficient stock\n  for WID-100')).toBe(
      'Insufficient stock for WID-100',
    );
    expect(readableReason('Cancelled by the customer')).toBe('Cancelled by the customer');
  });
});

describe('plainVars', () => {
  it("reads a step's variables as words, leaving out empty ones", () => {
    expect(plainVars('cycle=2')).toBe('Cycle 2');
    expect(plainVars('cycle=0, year=null')).toBe('Cycle 0');
    expect(plainVars('tier="gold", next_cycle=3')).toBe('Tier gold, Next cycle 3');
    expect(plainVars('year=null')).toBe('Nothing set');
  });

  it('is null for text that is not a list of variables', () => {
    expect(plainVars('Subtotal $20.00')).toBeNull();
    expect(plainVars('cycle=2, and more')).toBeNull();
  });
});

describe('plainLog', () => {
  it('names an outside event by the step beside it, not by its key', () => {
    expect(plainLog('Waiting for seller.responded', 'Seller responds')).toBe('Waiting');
    expect(plainLog('Waiting for return.requested: timed out', 'Return window')).toBe('Timed out');
    expect(plainLog('return.requested: timed out', 'Return window')).toBe('Timed out');
    expect(plainLog('payment.received received', 'Payment received')).toBe('Received');
    // What the engine writes now: the step's label (stripped by the timeline), then the outcome.
    expect(plainLog('waiting', 'Payment received')).toBe('Waiting');
  });

  it('reads the key as words when no step is shown', () => {
    expect(plainLog('Waiting for seller.responded')).toBe('Waiting for seller responded');
    expect(plainLog('return.requested: timed out')).toBe('Return requested: timed out');
    expect(eventName('return.requested')).toBe('Return requested');
  });

  it('reads variables, drops ids and names assignees', () => {
    expect(plainLog('cycle=2', 'Next cycle')).toBe('Cycle 2');
    expect(plainLog('cycle=0, year=null', 'Start year')).toBe('Cycle 0');
    expect(plainLog('Awaiting approval: Approve order ord_x1 for cus_contoso (sales_ops)')).toBe(
      'Awaiting approval: Approve order (Sales ops)',
    );
    expect(plainLog('Order created on Web order v3')).toBe('Order created on Web order v3');
  });
});
