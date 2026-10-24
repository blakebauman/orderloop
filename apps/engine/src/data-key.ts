/**
 * Secrets at rest (see `encryptSecret` in @orderloop/core): the outbox reads webhook signing
 * secrets, the A2A agent stores push credentials, and the daily sweep (`resealSecrets`) moves every
 * stored secret onto the current `DATA_KEY`, encrypting any stored before encryption.
 */

import {
  decryptSecret,
  encryptSecret,
  SecretUnreadable,
  sealedWithCurrent,
  secretContext,
} from '@orderloop/core';
import { createDb, integrations, pluginSecrets, users, webhookSubscriptions } from '@orderloop/db';
import { and, eq, isNotNull } from 'drizzle-orm';

/** `DATA_KEY`, then `DATA_KEY_PREVIOUS` while a rotation finishes. */
export const dataKeys = (env: Env) => [env.DATA_KEY, env.DATA_KEY_PREVIOUS] as const;

export const sealSecret = (env: Env, plaintext: string, context: string) =>
  encryptSecret(dataKeys(env), plaintext, context);

export const openSecret = (env: Env, stored: string, context: string) =>
  decryptSecret(dataKeys(env), stored, context);

/** One stored secret column, and the context its values are sealed for. */
type Column = {
  name: string;
  rows: (db: ReturnType<typeof createDb>) => Promise<{ id: string; value: string | null }[]>;
  /** Writes `next` only if the value is still `was`, so a rotation in between isn't undone. */
  write: (
    db: ReturnType<typeof createDb>,
    id: string,
    was: string,
    next: string,
  ) => Promise<unknown>;
  context: (id: string) => string;
};

const COLUMNS: Column[] = [
  {
    name: 'users.totp_secret',
    rows: (db) =>
      db
        .select({ id: users.id, value: users.totpSecret })
        .from(users)
        .where(isNotNull(users.totpSecret)),
    write: (db, id, was, next) =>
      db
        .update(users)
        .set({ totpSecret: next })
        .where(and(eq(users.id, id), eq(users.totpSecret, was))),
    context: secretContext.totp,
  },
  {
    name: 'webhook_subscriptions.secret',
    rows: (db) =>
      db
        .select({ id: webhookSubscriptions.id, value: webhookSubscriptions.secret })
        .from(webhookSubscriptions),
    write: (db, id, was, next) =>
      db
        .update(webhookSubscriptions)
        .set({ secret: next })
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.secret, was))),
    context: secretContext.webhookSubscription,
  },
  {
    name: 'webhook_subscriptions.previous_secret',
    rows: (db) =>
      db
        .select({ id: webhookSubscriptions.id, value: webhookSubscriptions.previousSecret })
        .from(webhookSubscriptions)
        .where(isNotNull(webhookSubscriptions.previousSecret)),
    write: (db, id, was, next) =>
      db
        .update(webhookSubscriptions)
        .set({ previousSecret: next })
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.previousSecret, was))),
    context: secretContext.webhookSubscription,
  },
  {
    name: 'integrations.secret',
    rows: (db) => db.select({ id: integrations.id, value: integrations.secret }).from(integrations),
    write: (db, id, was, next) =>
      db
        .update(integrations)
        .set({ secret: next })
        .where(and(eq(integrations.id, id), eq(integrations.secret, was))),
    context: secretContext.integration,
  },
  {
    name: 'integrations.previous_secret',
    rows: (db) =>
      db
        .select({ id: integrations.id, value: integrations.previousSecret })
        .from(integrations)
        .where(isNotNull(integrations.previousSecret)),
    write: (db, id, was, next) =>
      db
        .update(integrations)
        .set({ previousSecret: next })
        .where(and(eq(integrations.id, id), eq(integrations.previousSecret, was))),
    context: secretContext.integration,
  },
  {
    // A runtime-installed plugin's secrets: one row per plugin and name, keyed here as both.
    name: 'plugin_secrets.value',
    rows: async (db) =>
      (
        await db
          .select({
            pluginId: pluginSecrets.pluginId,
            name: pluginSecrets.name,
            value: pluginSecrets.value,
          })
          .from(pluginSecrets)
      ).map((r) => ({ id: `${r.pluginId}/${r.name}`, value: r.value })),
    write: (db, id, was, next) => {
      const [pluginId, name] = id.split('/') as [string, string];
      return db
        .update(pluginSecrets)
        .set({ value: next })
        .where(
          and(
            eq(pluginSecrets.pluginId, pluginId),
            eq(pluginSecrets.name, name),
            eq(pluginSecrets.value, was),
          ),
        );
    },
    context: (id) => {
      const [pluginId, name] = id.split('/') as [string, string];
      return secretContext.plugin(pluginId, name);
    },
  },
];

/**
 * Seals every stored secret under the current `DATA_KEY`: values stored before encryption, and
 * values under `DATA_KEY_PREVIOUS` after a rotation. `unreadable` counts values neither key opens
 * (each is logged). Once a sweep has run with both keys and nothing is unreadable, nothing needs
 * `DATA_KEY_PREVIOUS` any more.
 */
export async function resealSecrets(env: Env) {
  const keys = dataKeys(env);
  if (!keys[0]) {
    console.error('DATA_KEY is not set: secrets at rest are not resealed');
    return { resealed: 0, unreadable: 0 };
  }
  const db = createDb(env.DB);
  let resealed = 0;
  let unreadable = 0;
  for (const column of COLUMNS) {
    for (const { id, value } of await column.rows(db)) {
      if (!value || (await sealedWithCurrent(keys, value))) continue;
      const context = column.context(id);
      try {
        const plaintext = await decryptSecret(keys, value, context);
        await column.write(db, id, value, await encryptSecret(keys, plaintext, context));
        resealed++;
      } catch (err) {
        if (!(err instanceof SecretUnreadable)) throw err;
        console.error(
          `reseal: ${column.name} for ${id} can't be read with DATA_KEY or DATA_KEY_PREVIOUS`,
        );
        unreadable++;
      }
    }
  }
  return { resealed, unreadable };
}
