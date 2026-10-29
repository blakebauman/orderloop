import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { segments, unanswered } from '../app/components/assistant/panel';
import {
  ActionCard,
  NoAnswerLine,
  ReadLine,
  ReasoningLine,
  SourcesLine,
  sourcesOf,
} from '../app/components/assistant/parts';

type Parts = Parameters<typeof segments>[0];
type Tool = Parameters<typeof ReadLine>[0]['part'];

const read = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'tool-find_orders',
    toolCallId: `call-${state}`,
    state,
    input: {},
    ...extra,
  }) as unknown as Tool;

const html = (node: ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));

describe('assistant message segments', () => {
  it('gathers thinking and reads that run together into one trace', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'reasoning', text: 'Look for failed orders.', state: 'done' },
      read('output-available', { output: { count: 2, total: '$40.00' } }),
      { type: 'text', text: ' ' },
      { type: 'step-start' },
      read('output-available', { output: { count: 0, total: '$0.00' } }),
      { type: 'text', text: 'Two orders failed.' },
      read('input-available'),
    ] as unknown as Parts;
    const segs = segments(parts);
    expect(segs.map((s) => (s.trace ? s.trace.map((t) => t.i) : s.part.i))).toEqual([
      [1, 2, 5],
      6,
      [7],
    ]);
  });

  it('keeps an action that asks, and drafts, out of the trace', () => {
    const parts = [
      read('output-available', { output: { count: 1, total: '$1.00' } }),
      { type: 'tool-cancel_order', toolCallId: 'c', state: 'approval-requested', input: {} },
      { type: 'tool-draft_plugin', toolCallId: 'd', state: 'input-available', input: {} },
    ] as unknown as Parts;
    expect(segments(parts).map((s) => Boolean(s.trace))).toEqual([true, false, false]);
  });

  it('gathers an answered or replaced action into the trace with the reads', () => {
    const parts = [
      read('output-available', { output: { count: 1, total: '$1.00' } }),
      { type: 'tool-cancel_order', toolCallId: 'c', state: 'output-available', input: {} },
      { type: 'tool-cancel_order', toolCallId: 'e', state: 'approval-requested', input: {} },
      { type: 'tool-cancel_order', toolCallId: 'f', state: 'approval-requested', input: {} },
    ] as unknown as Parts;
    const segs = segments(parts, (i) => i === 2);
    expect(segs.map((s) => (s.trace ? s.trace.map((t) => t.i) : s.part.i))).toEqual([[0, 1, 2], 3]);
  });
});

describe('ActionCard once answered', () => {
  const action = (state: string, extra: Record<string, unknown> = {}) =>
    ({
      type: 'tool-cancel_order',
      toolCallId: `act-${state}`,
      state,
      input: { orderId: 'ord_1' },
      ...extra,
    }) as unknown as Tool;
  const card = (part: Tool, replaced = false) =>
    html(
      createElement(ActionCard, {
        part,
        preview: () => new Promise<never>(() => {}),
        respond: () => {},
        actionKey: 'k',
        replaced,
      }),
    );

  it('is a line in the words of what happened, linked to it', () => {
    const out = card(
      action('output-available', { output: { done: 'Cancelled ORD-1.', href: '/orders/ord_1' } }),
    );
    expect(out).toContain('data-slot="trace-line"');
    expect(out).toContain('Cancelled ORD-1.');
    expect(out).toContain('href="/orders/ord_1"');
    expect(out).not.toContain('<button');
  });

  it('says a declined action was left as it was, neutrally', () => {
    const out = card(action('output-denied'));
    expect(out).toContain('left as it was. You declined.');
    expect(out).not.toContain('data-status');
  });

  it('opens a failed action on its error', () => {
    const out = card(action('output-error', { errorText: 'Order already shipped' }));
    expect(out).toContain('data-status="error"');
    expect(out).toContain('didn’t go through');
    expect(out).toContain('Order already shipped');
  });

  it('shimmers while an approved action runs', () => {
    const out = card(action('approval-responded', { approval: { id: 'a', approved: true } }));
    expect(out).toContain('data-status="running"');
  });

  it('says a replaced request was replaced', () => {
    const out = card(action('approval-requested', { approval: { id: 'a' } }), true);
    expect(out).toContain('replaced by the newer request below');
    expect(out).not.toContain('<button');
  });
});

describe('ReadLine', () => {
  it('shimmers while the turn streams', () => {
    const out = html(createElement(ReadLine, { part: read('input-available'), streaming: true }));
    expect(out).toContain('data-status="running"');
    expect(out).toContain('Searching orders');
  });

  it('says a read stopped when the turn ended without it', () => {
    const out = html(createElement(ReadLine, { part: read('input-available'), streaming: false }));
    expect(out).toContain('data-status="error"');
    expect(out).toContain('Searching orders stopped');
    expect(out).toContain('aria-expanded="true"');
  });

  it('opens a failed read on its error', () => {
    const part = read('output-error', { errorText: 'D1 timed out' });
    const out = html(createElement(ReadLine, { part, streaming: false }));
    expect(out).toContain('Searching orders failed');
    expect(out).toContain('D1 timed out');
  });

  it('states what a finished read found', () => {
    const part = read('output-available', { output: { count: 3, total: '$90.00' } });
    const out = html(createElement(ReadLine, { part, streaming: false }));
    expect(out).not.toContain('data-status');
    expect(out).toContain('Searched orders');
    expect(out).toContain('3 found · $90.00');
  });
});

describe('ReasoningLine', () => {
  it('is a plain line until there is thinking to show', () => {
    const out = html(createElement(ReasoningLine, { text: '', running: true }));
    expect(out).toContain('Thinking');
    expect(out).not.toContain('aria-expanded');
  });

  it('opens on the thinking once there is some, closed by default', () => {
    const out = html(createElement(ReasoningLine, { text: 'Check stock first.', running: false }));
    expect(out).toContain('Thought');
    expect(out).toContain('aria-expanded="false"');
  });
});

describe('sources', () => {
  const tool = (type: string, output: Record<string, unknown>, state = 'output-available') => ({
    type: `tool-${type}`,
    toolCallId: `${type}-${JSON.stringify(output)}`,
    state,
    input: {},
    output,
  });

  it('lists each record a reply opened once, in order, and leaves searches out', () => {
    const parts = [
      tool('find_orders', { count: 9, total: '$9.00', orders: [{ href: '/orders/a' }] }),
      tool('get_order', { id: 'ord_a', ref: '#A1', title: 'Desks', href: '/orders/ord_a' }),
      tool('get_flow', { id: 'f1', name: 'Checkout', href: '/flows/f1' }),
      tool('assess_order', { id: 'ord_a', ref: '#A1' }),
      tool('get_cart', { id: 'cart_1', title: '', href: '/carts/cart_1' }),
      tool('get_order', { href: '/orders/ord_b' }, 'output-error'),
    ] as unknown as Parts;
    expect(sourcesOf(parts)).toEqual([
      { href: '/orders/ord_a', label: '#A1 · Desks' },
      { href: '/flows/f1', label: 'Checkout' },
      { href: '/carts/cart_1', label: 'cart_1' },
    ]);
  });

  it('is one closed line that opens on a link to each record', () => {
    const out = html(
      createElement(SourcesLine, {
        sources: [
          { href: '/orders/ord_a', label: '#A1 · Desks' },
          { href: '/flows/f1', label: 'Checkout' },
        ],
      }),
    );
    expect(out).toContain('Used 2 records');
    expect(out).toContain('aria-expanded="false"');
  });

  it('links a flow read to its flow, as an order read links to its order', () => {
    const part = read('output-available', {
      output: { id: 'f1', name: 'Checkout', href: '/flows/f1' },
    });
    const flow = { ...part, type: 'tool-get_flow' } as Tool;
    expect(html(createElement(ReadLine, { part: flow, streaming: false }))).toContain(
      'href="/flows/f1"',
    );
  });
});

describe('a turn with no answer', () => {
  const thought = {
    type: 'reasoning',
    text: 'Let me get the details of that flow.',
    state: 'done',
  };
  const model = { source: 'model' as const };
  const turn = (
    parts: unknown[],
    metadata: { source?: 'model' | 'heuristic' | 'direct' } = model,
  ) => ({ parts, metadata }) as unknown as Parameters<typeof unanswered>[0];

  it('is a model turn of thinking and reads that ends without text', () => {
    // Seen live: Kimi thought "let me get the details", then stopped without calling anything.
    expect(
      unanswered(turn([{ type: 'step-start' }, thought, read('output-available'), thought])),
    ).toBe(true);
    expect(unanswered(turn([thought, { type: 'text', text: '  ' }]))).toBe(true);
  });

  it('is not one with text, an action, a proposal or a draft, nor one the model did not write', () => {
    expect(unanswered(turn([thought, { type: 'text', text: 'Point-of-sale sale.' }]))).toBe(false);
    const action = (state: string) => ({
      type: 'tool-cancel_order',
      toolCallId: 'c',
      state,
      input: {},
    });
    expect(unanswered(turn([thought, action('approval-requested')]))).toBe(false);
    expect(unanswered(turn([thought, action('output-available')]))).toBe(false);
    expect(
      unanswered(
        turn([{ type: 'tool-propose_flow_change', toolCallId: 'p', state: 'output-available' }]),
      ),
    ).toBe(false);
    expect(
      unanswered(turn([{ type: 'tool-draft_plugin', toolCallId: 'd', state: 'output-available' }])),
    ).toBe(false);
    expect(unanswered(turn([thought], { source: 'direct' }))).toBe(false);
    expect(unanswered(turn([thought], {}))).toBe(false);
  });

  it('says so in a Trace line', () => {
    expect(html(createElement(NoAnswerLine))).toContain('Stopped without an answer');
    expect(html(createElement(NoAnswerLine))).toContain('data-status="error"');
  });
});
