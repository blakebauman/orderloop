/**
 * OrderLoop as an A2A (Agent2Agent, protocol 1.0) agent: what its Agent Card says, and how an
 * order's status reads as an A2A task state. The web app serves the card at
 * `/.well-known/agent-card.json`; the engine (apps/engine/src/a2a/) answers JSON-RPC at `/a2a`.
 * Plain data in the protocol's JSON form, so the docs can render it and nothing here depends on
 * the A2A SDK.
 */

import type { OrderState } from './api';
import { ASSISTANT_TOOLS, type AssistantTool } from './assistant';
import { ROLES, type Role } from './roles';
import type { OrderStatus } from './types';

export const A2A_PATH = '/a2a';
export const A2A_PROTOCOL_VERSION = '1.0';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export type A2ASkill = AssistantTool | 'place_order' | 'chat';

/**
 * Everything a caller can ask for. A typed request names a skill in a data part,
 * `{ "skill": "find_orders", "input": { … } }`; text goes to `chat`. Like the tools, a skill the
 * caller's role can't use is refused.
 */
export const A2A_SKILLS: Record<
  A2ASkill,
  { role: Role; name: string; description: string; tags: string[]; examples: string[] }
> = {
  chat: {
    role: 'viewer',
    name: 'Ask the assistant',
    description:
      'Ask in plain language. The assistant answers from the same tools; an action it proposes waits (input-required) until you reply { "confirm": true }.',
    tags: ['assistant', 'orders'],
    examples: ['What needs attention?', 'Which orders over $10k are waiting for approval?'],
  },
  place_order: {
    role: 'operator',
    name: 'Place an order',
    description:
      'Start an order on a published flow ({ flowId, version?, input, vars? }, as POST /api/v1/orders). The task follows the order: working while it runs, input-required when it waits for an approval or event, then its outcome. Repeating a message id returns the same order.',
    tags: ['orders', 'write'],
    examples: ['{ "skill": "place_order", "input": { "flowId": "flow_b2b", "input": { … } } }'],
  },
  ...(Object.fromEntries(
    (Object.keys(ASSISTANT_TOOLS) as AssistantTool[]).map((name) => {
      const t = ASSISTANT_TOOLS[name];
      return [
        name,
        {
          role: t.role,
          name: t.title,
          description: t.description,
          tags: ['orders', t.confirm ? 'write' : 'read'],
          examples: [`{ "skill": "${name}", "input": { … } }`],
        },
      ];
    }),
  ) as Record<AssistantTool, (typeof A2A_SKILLS)['chat']>),
};

export const isA2ASkill = (name: unknown): name is A2ASkill =>
  typeof name === 'string' && name in A2A_SKILLS;

/** A2A task states, as the protocol's JSON names them. */
export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

export const TERMINAL_TASK_STATES: A2ATaskState[] = [
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
];

export const ORDER_TASK_STATES: Record<OrderStatus, A2ATaskState> = {
  queued: 'TASK_STATE_WORKING',
  running: 'TASK_STATE_WORKING',
  waiting: 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
  rolled_back: 'TASK_STATE_CANCELED',
  declined: 'TASK_STATE_REJECTED',
};

/** An order as a task state, with one line saying where it is and what a reply can do. */
export function orderTaskState(s: OrderState): { state: A2ATaskState; text: string } {
  const state = ORDER_TASK_STATES[s.status];
  const ref = s.orderId ?? 'The order';
  if (s.status !== 'waiting' || !s.waits.length)
    return {
      state,
      text: `${ref} is ${s.status.replace('_', ' ')}${s.reason ? `: ${s.reason}` : ''}.`,
    };
  const waits = s.waits.map((w) =>
    w.kind === 'approval'
      ? `approval “${w.title}” (reply { "decision": "approved" | "rejected", "nodeId": "${w.nodeId}" })`
      : `event ${w.event ?? w.title} (reply { "event": "${w.event ?? ''}" })`,
  );
  return { state, text: `${ref} is waiting for ${waits.join('; ')}.` };
}

/** The public Agent Card for this origin, in A2A 1.0 JSON. */
export function agentCard(origin: string) {
  const roleScopes = Object.fromEntries(ROLES.map((r) => [r, `Act with the ${r} role`]));
  return {
    name: 'OrderLoop',
    description:
      'Runs each commerce order as a flow graph of steps; people step in at approvals, events and exceptions. Ask about orders, stock and flows, place orders and follow them to their outcome, and decide approvals, all within the role you connect with.',
    supportedInterfaces: [
      {
        url: `${origin}${A2A_PATH}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: 'OrderLoop', url: origin },
    version: '1.0.0',
    documentationUrl: 'https://docs.orderloop.io/reference/a2a/',
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      apiToken: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          description: 'An OrderLoop API token (ol_live_…), created on the Settings page.',
        },
      },
      oauth: {
        oauth2SecurityScheme: {
          description: `OAuth 2.1 with PKCE. Request the resource ${origin}${A2A_PATH}; the scope is the role to act with.`,
          oauth2MetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/oauth/token`,
              scopes: roleScopes,
              pkceRequired: true,
            },
          },
        },
      },
    },
    securityRequirements: [
      { schemes: { apiToken: { list: [] } } },
      { schemes: { oauth: { list: [] } } },
    ],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: (Object.keys(A2A_SKILLS) as A2ASkill[]).map((id) => {
      const s = A2A_SKILLS[id];
      return {
        id,
        name: s.name,
        description: `${s.description} Needs the ${s.role} role.`,
        tags: s.tags,
        examples: s.examples,
      };
    }),
  };
}
