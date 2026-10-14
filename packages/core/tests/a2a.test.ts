import { describe, expect, it } from 'vitest';
import {
  A2A_SKILLS,
  agentCard,
  ORDER_TASK_STATES,
  orderTaskState,
  TERMINAL_TASK_STATES,
} from '../src/a2a';
import { EMPTY_ORDER_STATE } from '../src/api';
import { ASSISTANT_TOOLS } from '../src/assistant';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../src/types';

describe('A2A', () => {
  it('reads every order status as a task state, finished orders as finished tasks', () => {
    for (const status of ORDER_STATUSES)
      expect(TERMINAL_TASK_STATES.includes(ORDER_TASK_STATES[status])).toBe(
        TERMINAL_ORDER_STATUSES.includes(status),
      );
  });

  it('says what a waiting order needs and how to reply', () => {
    const { state, text } = orderTaskState({
      ...EMPTY_ORDER_STATE,
      orderId: 'ord_1',
      status: 'waiting',
      waits: [
        { nodeId: 'n1', eventType: 'e1', kind: 'approval', title: 'Sales approval', since: 0 },
        {
          nodeId: 'n2',
          eventType: 'e2',
          kind: 'event',
          title: 'Payment',
          event: 'payment.received',
          since: 0,
        },
      ],
    });
    expect(state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(text).toContain('“Sales approval”');
    expect(text).toContain('"nodeId": "n1"');
    expect(text).toContain('{ "event": "payment.received" }');
  });

  it('offers every tool as a skill at the same role', () => {
    for (const [name, t] of Object.entries(ASSISTANT_TOOLS))
      expect(A2A_SKILLS[name as keyof typeof A2A_SKILLS].role).toBe(t.role);
    expect(A2A_SKILLS.place_order.role).toBe('operator');
  });

  it('points the card at this origin', () => {
    const card = agentCard('https://orderloop.io');
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://orderloop.io/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
    expect(card.securitySchemes.oauth.oauth2SecurityScheme.oauth2MetadataUrl).toBe(
      'https://orderloop.io/.well-known/oauth-authorization-server',
    );
  });
});
