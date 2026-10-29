import { orderInputSchema, TEMPLATES, validateGraph } from '@orderloop/core';
import { describe, expect, it } from 'vitest';
import {
  ago,
  channelLabel,
  clip,
  clock,
  dateTime,
  duration,
  money,
  plural,
  statusColor,
  waitingForLabel,
  waitLabel,
} from '../app/lib/format';
import { SCENARIOS } from '../app/lib/scenarios';

const templates = Object.values(TEMPLATES).map((t) => t());

describe('demo scenarios', () => {
  for (const s of SCENARIOS) {
    it(`${s.id} targets a valid seeded flow of its order type`, () => {
      const flow = templates.find((t) => t.id === s.flowId);
      expect(flow, `no template ${s.flowId}`).toBeDefined();
      expect(flow!.model).toBe(s.input.model);
      expect(validateGraph(flow!).errors).toEqual([]);
      expect(orderInputSchema.safeParse(s.input).success).toBe(true);
    });
  }
});

describe('format', () => {
  it('names a wait without engine ids, or a customer that interpolated to nothing', () => {
    expect(waitLabel('Approve B2B order ord_mv6r5qrzvb6sbz for cus_contoso')).toBe(
      'Approve B2B order',
    );
    // Flows published before the B2B template dropped the customer, for an unknown sender.
    expect(waitLabel('Approve B2B order ord_mv6r5qrzvb6sbz for ')).toBe('Approve B2B order');
    expect(waitLabel('Approve B2B order ord_mv6r5qrzvb6sbz')).toBe('Approve B2B order');
    expect(waitLabel('Waiting for payment.received · Approve B2B order ord_x1 for ')).toBe(
      'Payment · Approve B2B order',
    );
    // An event a custom flow invents keeps its own name.
    expect(waitLabel('Waiting for invoice.signed')).toBe('invoice.signed');
  });

  it('says who an order waits on, from the index', () => {
    expect(waitingForLabel('person:sales_ops')).toBe('Sales ops');
    expect(waitingForLabel('person:')).toBe('an approver');
    expect(waitingForLabel('event:payment.received · timer')).toBe('Payment, a timer');
    expect(waitingForLabel('event:invoice.signed')).toBe('invoice.signed');
    expect(waitingForLabel('person:manager · person:manager')).toBe('Manager');
    expect(waitingForLabel(null)).toBe('');
    // Assignees are named, not humanized from their ids.
    expect(waitingForLabel('person:ap · person:trust_safety')).toBe(
      'Accounts payable, Trust and safety',
    );
    expect(waitingForLabel('person:qa')).toBe('QA');
    expect(waitingForLabel('person:returns_desk')).toBe('Returns desk');
  });

  it('labels channels and clips free text to a line', () => {
    expect(channelLabel('pos')).toBe('Point of sale');
    expect(channelLabel('bench')).toBe('Other channel');
    expect(clip('Database error at\n  Supplier cost')).toBe('Database error at Supplier cost');
    const reason = clip(`Returned: ${'damaged in transit, '.repeat(200)}`);
    expect(reason.length).toBeLessThanOrEqual(160);
    expect(reason.endsWith('…')).toBe(true);
    // A database error stored before the engine named only where it happened reads that way too.
    expect(clip(`Supplier cost: Failed query: select ${'"sku", '.repeat(2000)}`)).toBe(
      'Database error at Supplier cost',
    );
    expect(plural(1, 'reservation')).toBe('1 reservation');
    expect(plural(1200, 'line')).toBe('1,200 lines');
  });

  it('formats money and relative time', () => {
    expect(money(1163.69)).toBe('$1,163.69');
    expect(ago(Date.now() - 90_000)).toBe('2m ago');
    expect(ago(null)).toBe('—');
  });

  it('formats date-times in a pinned zone for SSR and labels UTC', () => {
    const t = Date.UTC(2026, 9, 13, 4, 46);
    expect(dateTime(t, 'UTC')).toBe('Oct 13, 2026, 4:46 AM UTC');
    expect(dateTime(t, 'America/Los_Angeles')).toBe('Oct 12, 2026, 9:46 PM');
  });

  it('lays out date-times itself, whatever punctuation the ICU in use puts between the fields', () => {
    // WebKit's ICU joins a date and a time with " at " where workerd's uses ", ", and some put a
    // narrow no-break space before AM: a whole-string format broke hydration on the order page.
    const t = Date.UTC(2026, 9, 29, 5, 40);
    expect(dateTime(t, 'UTC')).toBe('Oct 29, 2026, 5:40 AM UTC');
    expect(dateTime(t, 'UTC')).not.toMatch(/[\u202f\u00a0]/);
    expect(clock(t, 'UTC')).toBe('5:40 AM');
    expect(clock(t, 'UTC', true)).toBe('Thu 5:40 AM');
  });

  it('maps statuses to theme tokens', () => {
    expect(statusColor('waiting')).toBe('var(--wait)');
    expect(statusColor('nonsense')).toBe('var(--idle)');
  });
});

describe('duration', () => {
  it('picks a unit that keeps the figure short', () => {
    expect(
      [12, 1_400, 45_000, 180_000, 9_000_000, 7_200_000 * 3, 4 * 86_400_000].map(duration),
    ).toEqual(['12ms', '1s', '45s', '3m', '2.5h', '6h', '4d']);
  });
});
