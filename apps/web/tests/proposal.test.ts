import { EMPTY_ORDER_STATE, type OrderState } from '@orderloop/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Proposal } from '../app/components/proposal';

const waiting: OrderState = {
  ...EMPTY_ORDER_STATE,
  orderId: 'ord_test',
  status: 'waiting',
  waits: [
    {
      nodeId: 'approval',
      eventType: 'approval-ord_test',
      kind: 'approval',
      title: 'Approve B2B order',
      since: 0,
    },
  ],
};

const render = (p: Parameters<typeof Proposal>[0]['p'], state = waiting) =>
  renderToStaticMarkup(
    createElement(Proposal, { p, state, busy: null, call: async () => undefined, by: 'dana' }),
  );

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, '').trim(),
  );

describe('chat proposal card', () => {
  it('offers only the proposed decision, prefilled with its note, and sends nothing yet', () => {
    const html = render({
      kind: 'decide',
      nodeId: 'approval',
      decision: 'approved',
      note: 'checked with finance',
    });
    expect(buttons(html)).toEqual(['Approve', 'Dismiss']);
    expect(html).toContain('value="checked with finance"');
  });

  it('offers Reject alone for a proposed rejection', () => {
    const html = render({ kind: 'decide', nodeId: 'approval', decision: 'rejected' });
    expect(buttons(html)).toEqual(['Reject', 'Dismiss']);
  });

  it('says there is nothing to confirm once the step stopped waiting', () => {
    const html = render(
      { kind: 'decide', nodeId: 'approval', decision: 'approved' },
      { ...waiting, waits: [] },
    );
    expect(buttons(html)).toEqual([]);
    expect(html).toContain('no longer waiting');
  });

  it('asks before cancelling, and not at all once the order has finished', () => {
    expect(buttons(render({ kind: 'cancel', reason: 'Customer called' }))).toEqual([
      'Cancel order',
      'Dismiss',
    ]);
    const done = render({ kind: 'cancel', reason: 'x' }, { ...waiting, status: 'completed' });
    expect(buttons(done)).toEqual([]);
    expect(done).toContain('already finished');
  });
});
