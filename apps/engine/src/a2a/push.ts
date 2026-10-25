/**
 * A2A push notifications. A caller registers a URL per task (inline in SendMessage, or with the
 * push config methods); every update to that task is POSTed there as an A2A 1.0 StreamResponse.
 * Updates come from a live request (the SDK calls `send` for each event) and from the order itself
 * once no request is open (A2AAgent.orderChanged).
 *
 * Delivery is durable: each notification is a row in this object's SQLite, tried at once and
 * retried on the object's alarm with backoff, then left `failed`. The engine's fetch reaches only
 * public addresses (global_fetch_strictly_public), and a URL must be https (http only for
 * localhost).
 *
 * The caller's token and credentials are stored encrypted under `DATA_KEY` (@orderloop/core
 * `encryptSecret`), in the config and in each queued notification's headers. One sealed under a key
 * the deployment no longer has is dropped: the caller registers its URL again.
 */

import type { StreamResponse, Task, TaskPushNotificationConfig } from '@a2a-js/sdk';
import { V03PushNotificationSerializer } from '@a2a-js/sdk/compat/v0_3/server';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  type PushNotificationSender,
  type PushNotificationSerializer,
  type PushNotificationStore,
  type ServerCallContext,
  type StoredPushNotificationConfig,
  V1PushNotificationSerializer,
} from '@a2a-js/sdk/server';
import {
  A2A_LEGACY_PROTOCOL_VERSION,
  isLegacyA2AVersion,
  isWebhookUrl,
  SecretUnreadable,
  sealedWithCurrent,
  WEBHOOK_URL_RULE,
} from '@orderloop/core';
import { dataKeys, openSecret, sealSecret } from '../data-key';

/** Per task: enough for a caller and a backup, not a fan-out service. */
const MAX_CONFIGS = 5;
/** Matches outbound webhooks: the first try plus 5 retries, 10s apart and doubling. */
const RETRIES = 5;
const TIMEOUT_MS = 5_000;
/** Push URLs delivered to at once in a pass. */
const PARALLEL_URLS = 6;
/** Failed deliveries are kept this long for inspection. */
const KEEP_FAILED_MS = 7 * 86_400_000;

type ConfigRow = {
  task_id: string;
  id: string;
  url: string;
  token: string;
  auth_scheme: string | null;
  auth_credentials: string | null;
  wire_version: string;
};

/** Where a config's token and credentials are sealed for. */
const configContext = (taskId: string, id: string) => `push_configs:${taskId}/${id}`;
const outboxContext = (id: string) => `push_outbox:${id}`;

export class SqlPushStore implements PushNotificationStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS push_configs (
      task_id TEXT NOT NULL,
      id TEXT NOT NULL,
      url TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT '',
      auth_scheme TEXT,
      auth_credentials TEXT,
      created_at INTEGER NOT NULL,
      wire_version TEXT NOT NULL DEFAULT '1.0',
      PRIMARY KEY (task_id, id)
    )`);
    // Objects created before 0.3 support have the table without this column.
    const columns = sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('push_configs')")
      .toArray()
      .map((c) => c.name);
    if (!columns.includes('wire_version'))
      sql.exec("ALTER TABLE push_configs ADD COLUMN wire_version TEXT NOT NULL DEFAULT '1.0'");
  }

  async save(
    taskId: string,
    context: ServerCallContext,
    config: TaskPushNotificationConfig,
  ): Promise<void> {
    if (!isWebhookUrl(config.url)) throw new RequestMalformedError(WEBHOOK_URL_RULE);
    // The SDK reads the id back from the object it passed in.
    if (!config.id) config.id = crypto.randomUUID();
    config.taskId = taskId;
    const exists = this.sql
      .exec('SELECT 1 FROM push_configs WHERE task_id = ? AND id = ?', taskId, config.id)
      .toArray().length;
    const count = this.sql
      .exec<{ n: number }>('SELECT count(*) AS n FROM push_configs WHERE task_id = ?', taskId)
      .one().n;
    if (!exists && count >= MAX_CONFIGS)
      throw new RequestMalformedError(`A task takes at most ${MAX_CONFIGS} push URLs.`);
    const sealedFor = configContext(taskId, config.id);
    const token = config.token ? await sealSecret(this.env, config.token, sealedFor) : '';
    const credentials = config.authentication?.credentials
      ? await sealSecret(this.env, config.authentication.credentials, sealedFor)
      : null;
    this.sql.exec(
      `INSERT INTO push_configs
         (task_id, id, url, token, auth_scheme, auth_credentials, created_at, wire_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, id) DO UPDATE SET url = excluded.url, token = excluded.token,
         auth_scheme = excluded.auth_scheme, auth_credentials = excluded.auth_credentials,
         wire_version = excluded.wire_version`,
      taskId,
      config.id,
      config.url,
      token,
      config.authentication?.scheme || null,
      credentials,
      Date.now(),
      // A URL registered over 0.3 gets 0.3-shaped notifications.
      isLegacyA2AVersion(context.requestedVersion) ? A2A_LEGACY_PROTOCOL_VERSION : '1.0',
    );
  }

  async load(taskId: string, context?: ServerCallContext): Promise<TaskPushNotificationConfig[]> {
    return (await this.loadWithMetadata(taskId, context)).map((s) => s.config);
  }

  async loadWithMetadata(
    taskId: string,
    _context?: ServerCallContext,
  ): Promise<StoredPushNotificationConfig[]> {
    const rows = this.sql
      .exec<ConfigRow>('SELECT * FROM push_configs WHERE task_id = ? ORDER BY created_at', taskId)
      .toArray();
    const stored: StoredPushNotificationConfig[] = [];
    for (const r of rows) {
      const context = configContext(r.task_id, r.id);
      let token: string;
      let credentials: string;
      try {
        token = r.token ? await openSecret(this.env, r.token, context) : '';
        credentials = r.auth_credentials
          ? await openSecret(this.env, r.auth_credentials, context)
          : '';
      } catch (err) {
        if (!(err instanceof SecretUnreadable)) throw err;
        console.error(`a2a push: dropping ${context}, sealed under a key this deployment lacks`);
        this.sql.exec('DELETE FROM push_configs WHERE task_id = ? AND id = ?', r.task_id, r.id);
        continue;
      }
      await this.reseal(r, token, credentials);
      stored.push({
        wireVersion: r.wire_version,
        config: {
          tenant: '',
          id: r.id,
          taskId: r.task_id,
          url: r.url,
          token,
          authentication: r.auth_scheme ? { scheme: r.auth_scheme, credentials } : undefined,
        },
      });
    }
    return stored;
  }

  /** Seals a config stored before encryption, or under the previous key, under the current one. */
  private async reseal(r: ConfigRow, token: string, credentials: string) {
    const keys = dataKeys(this.env);
    if (!keys[0]) return;
    const stale = async (v: string | null) => !!v && !(await sealedWithCurrent(keys, v));
    if (!(await stale(r.token)) && !(await stale(r.auth_credentials))) return;
    const context = configContext(r.task_id, r.id);
    this.sql.exec(
      'UPDATE push_configs SET token = ?, auth_credentials = ? WHERE task_id = ? AND id = ?',
      token ? await sealSecret(this.env, token, context) : '',
      r.auth_credentials ? await sealSecret(this.env, credentials, context) : null,
      r.task_id,
      r.id,
    );
  }

  /** Removes a config (or all of a task's) and drops what is still queued for it. */
  async delete(taskId: string, _context: ServerCallContext, configId?: string): Promise<void> {
    if (configId) {
      this.sql.exec('DELETE FROM push_configs WHERE task_id = ? AND id = ?', taskId, configId);
      this.sql.exec(
        "DELETE FROM push_outbox WHERE task_id = ? AND config_id = ? AND status = 'pending'",
        taskId,
        configId,
      );
    } else {
      this.sql.exec('DELETE FROM push_configs WHERE task_id = ?', taskId);
      this.sql.exec("DELETE FROM push_outbox WHERE task_id = ? AND status = 'pending'", taskId);
    }
  }
}

type OutboxRow = {
  id: string;
  url: string;
  headers: string;
  body: string;
  attempts: number;
};

/** Headers that prove a notification came from the agent the caller registered with. */
function authHeaders(config: TaskPushNotificationConfig): Record<string, string> {
  if (config.authentication?.scheme && config.authentication.credentials)
    return {
      authorization: `${config.authentication.scheme} ${config.authentication.credentials}`,
    };
  return config.token ? { 'x-a2a-notification-token': config.token } : {};
}

export class PushSender implements PushNotificationSender {
  private readonly serializers: Record<string, PushNotificationSerializer> = {
    '1.0': new V1PushNotificationSerializer(),
    [A2A_LEGACY_PROTOCOL_VERSION]: new V03PushNotificationSerializer(),
  };
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly configs: SqlPushStore,
    private readonly env: Env,
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS push_outbox (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      url TEXT NOT NULL,
      headers TEXT NOT NULL,
      body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at INTEGER NOT NULL
    )`);
    storage.sql.exec('CREATE INDEX IF NOT EXISTS push_outbox_due ON push_outbox (status, next_at)');
    // The last status pushed per task. A live request and the order itself can both report the
    // same change; it goes out once.
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS push_last (task_id TEXT PRIMARY KEY, status TEXT NOT NULL)',
    );
  }

  /** Queues the update for every URL registered on its task, then tries to deliver it. */
  async send(update: StreamResponse, _context?: ServerCallContext, task?: Task): Promise<void> {
    const taskId = taskIdOf(update) ?? task?.id;
    if (!taskId) return;
    const configs = await this.configs.loadWithMetadata(taskId);
    if (!configs.length) return;
    if (update.payload?.$case === 'statusUpdate' && this.repeats(taskId, update)) return;
    const now = Date.now();
    for (const { config, wireVersion } of configs) {
      const serializer = this.serializers[wireVersion] ?? this.serializers['1.0']!;
      const { body, contentType } = serializer.serialize(update, task);
      const id = crypto.randomUUID();
      // Sealed: they carry the caller's token or credentials.
      const headers = await sealSecret(
        this.env,
        JSON.stringify({ 'content-type': contentType, ...authHeaders(config) }),
        outboxContext(id),
      );
      this.storage.sql.exec(
        `INSERT INTO push_outbox (id, task_id, config_id, url, headers, body, next_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        taskId,
        config.id,
        config.url,
        headers,
        body,
        now,
        now,
      );
    }
    // Tried now without holding up the caller; the alarm is the backstop if this object is
    // evicted before the first try finishes.
    await this.arm();
    this.deliver().catch((err) => console.error('a2a push: delivery pass failed', err));
  }

  /** Whether this status is the one last pushed for the task; records it when it isn't. */
  private repeats(taskId: string, update: StreamResponse): boolean {
    if (update.payload?.$case !== 'statusUpdate') return false;
    const st = update.payload.value.status;
    const text = st?.message?.parts
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    const key = `${st?.state} ${text ?? ''}`;
    const last = this.storage.sql
      .exec<{ status: string }>('SELECT status FROM push_last WHERE task_id = ?', taskId)
      .toArray()[0]?.status;
    if (last === key) return true;
    this.storage.sql.exec(
      'INSERT OR REPLACE INTO push_last (task_id, status) VALUES (?, ?)',
      taskId,
      key,
    );
    return false;
  }

  /** Tries every due notification once; one pass at a time, each URL's in queue order. */
  deliver(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** One delivery attempt: removes the row once delivered, else schedules its retry. */
  private async attempt(row: OutboxRow) {
    let error: string | null = null;
    try {
      const headers = await openSecret(this.env, row.headers, outboxContext(row.id));
      const res = await fetch(row.url, {
        method: 'POST',
        headers: JSON.parse(headers) as Record<string, string>,
        body: row.body,
        // The caller's token and credentials go to the URL they registered, never where it points.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (res.status >= 300 && res.status < 400)
        error = `HTTP ${res.status} (redirects aren't followed)`;
      else if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (!error) {
      this.storage.sql.exec('DELETE FROM push_outbox WHERE id = ?', row.id);
      return;
    }
    const attempts = row.attempts + 1;
    const failed = attempts > RETRIES;
    this.storage.sql.exec(
      `UPDATE push_outbox SET attempts = ?, status = ?, next_at = ?, last_error = ?,
         updated_at = ? WHERE id = ?`,
      attempts,
      failed ? 'failed' : 'pending',
      Date.now() + 10_000 * 2 ** (attempts - 1),
      error,
      Date.now(),
      row.id,
    );
  }

  private async pass() {
    const now = Date.now();
    const due = this.storage.sql
      .exec<OutboxRow>(
        `SELECT id, url, headers, body, attempts FROM push_outbox
         WHERE status = 'pending' AND next_at <= ? ORDER BY next_at, rowid`,
        now,
      )
      .toArray();
    // A URL's notifications go one after another, in queue order; different URLs go together,
    // a few at a time.
    const byUrl = new Map<string, OutboxRow[]>();
    for (const row of due) {
      const q = byUrl.get(row.url);
      if (q) q.push(row);
      else byUrl.set(row.url, [row]);
    }
    const queues = [...byUrl.values()];
    for (let i = 0; i < queues.length; i += PARALLEL_URLS)
      await Promise.all(
        queues.slice(i, i + PARALLEL_URLS).map(async (q) => {
          for (const row of q) await this.attempt(row);
        }),
      );
    this.storage.sql.exec(
      "DELETE FROM push_outbox WHERE status = 'failed' AND updated_at < ?",
      Date.now() - KEEP_FAILED_MS,
    );
    await this.arm();
  }

  /** Sets the alarm for the next pending notification, if any. */
  private async arm() {
    const next = this.storage.sql
      .exec<{ at: number | null }>(
        "SELECT min(next_at) AS at FROM push_outbox WHERE status = 'pending'",
      )
      .one().at;
    if (next !== null) await this.storage.setAlarm(next);
  }
}

function taskIdOf(update: StreamResponse): string | undefined {
  const p = update.payload;
  if (!p) return undefined;
  switch (p.$case) {
    case 'task':
      return p.value.id;
    case 'message':
      return p.value.taskId || undefined;
    case 'statusUpdate':
    case 'artifactUpdate':
      return p.value.taskId;
  }
}
