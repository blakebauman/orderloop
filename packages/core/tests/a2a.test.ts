import { describe, expect, it } from 'vitest';
import {
  A2A_SKILLS,
  agentCard,
  isLegacyA2AVersion,
  legacyAgentCard,
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
    // A write is tagged one whether or not it waits for a confirm.
    for (const name of ['create_cart', 'change_cart', 'draft_plugin', 'submit_cart'] as const)
      expect(A2A_SKILLS[name].tags, name).toContain('write');
    expect(A2A_SKILLS.get_cart.tags).toContain('read');
  });

  it('points the card at this origin', () => {
    const card = agentCard('https://orderloop.app');
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://orderloop.app/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'https://orderloop.app/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ]);
    expect(card.securitySchemes.oauth.oauth2SecurityScheme.oauth2MetadataUrl).toBe(
      'https://orderloop.app/.well-known/oauth-authorization-server',
    );
  });
  it('serves 0.3 clients a 0.3 card that still names the 1.0 interface', () => {
    const card = legacyAgentCard('https://orderloop.app');
    expect(card).toMatchObject({
      url: 'https://orderloop.app/a2a',
      preferredTransport: 'JSONRPC',
      protocolVersion: '0.3',
      security: [{ apiToken: [] }, { oauth: [] }],
    });
    expect(card.securitySchemes.apiToken).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(card.supportedInterfaces.map((i) => i.protocolVersion)).toEqual(['1.0', '0.3']);
    expect(card.skills).toEqual(agentCard('https://orderloop.app').skills);
  });

  it('treats a missing or 0.x version as a 0.3 client', () => {
    expect(isLegacyA2AVersion(null)).toBe(true);
    expect(isLegacyA2AVersion('')).toBe(true);
    expect(isLegacyA2AVersion('0.3')).toBe(true);
    expect(isLegacyA2AVersion('1.0')).toBe(false);
  });
});
