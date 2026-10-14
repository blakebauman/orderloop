/**
 * A2A tasks in the caller's A2AAgent SQLite. Only that caller reaches the object, so every task
 * here is theirs. A task can follow an order (`order_id`) or hold an action the assistant proposed
 * (`pending`) until the caller confirms it.
 *
 * A task that follows an order is read through the order: while it hasn't finished, `load` and
 * `list` take its state from the OrderAgent's snapshot, so GetTask is current without anything
 * polling in the background.
 */

import { type ListTasksRequest, type ListTasksResponse, Task, TaskState } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { orderTaskState } from '@orderloop/core';
import { snapshot } from '../assistant/data';
import { agentStatus } from './parts';

/** An action the assistant proposed in a chat task, waiting for `{ "confirm": true }`. */
export type PendingAction = { tool: string; input: Record<string, unknown> };

const TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export const isTerminal = (t: Task | undefined) =>
  t?.status !== undefined && TERMINAL.has(t.status.state);

type Row = { json: string; order_id: string | null };

const SELECT = 'SELECT t.json, l.order_id FROM tasks t LEFT JOIN task_links l ON l.task_id = t.id';

export class SqlTaskStore implements TaskStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      state INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      json TEXT NOT NULL
    )`);
    // Kept apart from the task row: the executor links a task before the SDK has saved it.
    sql.exec(`CREATE TABLE IF NOT EXISTS task_links (
      task_id TEXT PRIMARY KEY,
      order_id TEXT,
      pending TEXT
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS tasks_updated ON tasks (updated_at DESC)');
    sql.exec('CREATE INDEX IF NOT EXISTS tasks_context ON tasks (context_id, updated_at)');
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    this.sql.exec(
      `INSERT INTO tasks (id, context_id, state, updated_at, json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         context_id = excluded.context_id, state = excluded.state,
         updated_at = excluded.updated_at, json = excluded.json`,
      task.id,
      task.contextId,
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
      Date.now(),
      JSON.stringify(Task.toJSON(task)),
    );
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    const row = this.sql.exec<Row>(`${SELECT} WHERE t.id = ?`, taskId).toArray()[0];
    return row ? this.current(row) : undefined;
  }

  async list(params: ListTasksRequest, _context?: ServerCallContext): Promise<ListTasksResponse> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.contextId) {
      where.push('context_id = ?');
      args.push(params.contextId);
    }
    if (params.status) {
      where.push('state = ?');
      args.push(params.status);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
    const offset = Number.parseInt(params.pageToken || '0', 10) || 0;
    const total = this.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM tasks t ${filter}`, ...args)
      .one().n;
    const rows = this.sql
      .exec<Row>(
        `${SELECT} ${filter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...args,
        pageSize,
        offset,
      )
      .toArray();
    const tasks = await Promise.all(rows.map((r) => this.current(r)));
    const next = offset + rows.length;
    return {
      tasks,
      nextPageToken: next < total ? String(next) : '',
      pageSize,
      totalSize: total,
    };
  }

  /** The tasks of one conversation, oldest first: the history a chat turn continues. */
  inContext(contextId: string): Task[] {
    return this.sql
      .exec<Row>(`${SELECT} WHERE context_id = ? ORDER BY updated_at ASC`, contextId)
      .toArray()
      .map((r) => Task.fromJSON(JSON.parse(r.json)));
  }

  /** Makes a task follow an order. */
  follow(taskId: string, orderId: string) {
    this.sql.exec(
      `INSERT INTO task_links (task_id, order_id) VALUES (?, ?)
       ON CONFLICT (task_id) DO UPDATE SET order_id = excluded.order_id`,
      taskId,
      orderId,
    );
  }

  orderOf(taskId: string): string | null {
    return (
      this.sql
        .exec<{ order_id: string | null }>(
          'SELECT order_id FROM task_links WHERE task_id = ?',
          taskId,
        )
        .toArray()[0]?.order_id ?? null
    );
  }

  setPending(taskId: string, pending: PendingAction | null) {
    this.sql.exec(
      `INSERT INTO task_links (task_id, pending) VALUES (?, ?)
       ON CONFLICT (task_id) DO UPDATE SET pending = excluded.pending`,
      taskId,
      pending ? JSON.stringify(pending) : null,
    );
  }

  pendingOf(taskId: string): PendingAction | null {
    const raw = this.sql
      .exec<{ pending: string | null }>('SELECT pending FROM task_links WHERE task_id = ?', taskId)
      .toArray()[0]?.pending;
    return raw ? (JSON.parse(raw) as PendingAction) : null;
  }

  /** The stored task, with an unfinished order's state read from the order itself. */
  private async current(row: Row): Promise<Task> {
    const task = Task.fromJSON(JSON.parse(row.json));
    if (!row.order_id || isTerminal(task)) return task;
    const s = await snapshot(this.env, row.order_id);
    if (!s) return task;
    const { state, text } = orderTaskState(s);
    const status = agentStatus(task, state, text);
    if (status.state === task.status?.state && sameText(status, task.status)) return task;
    const updated = { ...task, status };
    await this.save(updated);
    return updated;
  }
}

const textOf = (s: Task['status']) =>
  s?.message?.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');

const sameText = (a: Task['status'], b: Task['status']) => textOf(a) === textOf(b);
