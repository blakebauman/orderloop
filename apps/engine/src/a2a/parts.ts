/**
 * A2A objects built from their protocol JSON (what goes over the wire), so the executor reads
 * like the spec rather than the SDK's protobuf shapes.
 */

import {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutionEvent } from '@a2a-js/sdk/server';
import type { A2ATaskState } from '@orderloop/core';

type Ids = { taskId: string; contextId: string };
type Json = Record<string, unknown>;

const message = ({ taskId, contextId }: Ids, text: string) => ({
  messageId: crypto.randomUUID(),
  role: 'ROLE_AGENT',
  taskId,
  contextId,
  parts: [{ text }],
});

const statusJson = (ids: Ids, state: A2ATaskState, text?: string) => ({
  state,
  timestamp: new Date().toISOString(),
  ...(text ? { message: message(ids, text) } : {}),
});

/** A status from the agent, with one line of text when there is something to say. */
export const agentStatus = (
  task: { id: string; contextId: string },
  state: A2ATaskState,
  text?: string,
) => TaskStatus.fromJSON(statusJson({ taskId: task.id, contextId: task.contextId }, state, text));

export function newTask(ids: Ids, userMessage: Message): AgentExecutionEvent {
  return AgentEvent.task(
    Task.fromJSON({
      id: ids.taskId,
      contextId: ids.contextId,
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
      history: [Message.toJSON(userMessage)],
    }),
  );
}

export const statusEvent = (ids: Ids, state: A2ATaskState, text?: string): AgentExecutionEvent =>
  AgentEvent.statusUpdate(
    TaskStatusUpdateEvent.fromJSON({ ...ids, status: statusJson(ids, state, text) }),
  );

/** A result as a data artifact. */
export function dataArtifact(ids: Ids, name: string, data: unknown): AgentExecutionEvent {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data };
  return AgentEvent.artifactUpdate(
    TaskArtifactUpdateEvent.fromJSON({
      ...ids,
      artifact: { artifactId: crypto.randomUUID(), name, parts: [{ data: value }] },
      lastChunk: true,
    }),
  );
}

/** What a message says: its text parts joined, and its first data part. */
export function readMessage(m: Message): { text: string; data: Json | undefined } {
  const json = Message.toJSON(m) as { parts?: { text?: string; data?: unknown }[] };
  const parts = json.parts ?? [];
  const text = parts
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
  const data = parts.find((p) => p.data && typeof p.data === 'object')?.data as Json | undefined;
  return { text, data };
}
