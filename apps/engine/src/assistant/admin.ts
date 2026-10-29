/**
 * The Team and Plugins pages' changes through the assistant, for admins: a person's role, whether
 * people may approve their own orders, and installed plugins (turn on or off, approve, roll back,
 * uninstall, run a draft's test cases). Each stops for a confirm, and the ones the pages already
 * made people prove it was them for (`stepUpNeeded`) need a step-up on the session within
 * `STEP_UP_MS` too: the engine reads when it last happened from the session itself.
 *
 * Disabling or enabling a person stays on the Team page: it ends their connected apps, which only
 * the web app's OAuth store can do.
 */

import {
  type ActionPreview,
  APPROVAL_SEPARATION_KEY,
  ASSISTANT_ROUTING_KEY,
  boundText,
  type PluginCase,
  type Principal,
  ROLE_LABELS,
  ROLES,
  type Role,
  STEP_UP_MS,
  STEP_UP_NEEDED,
} from '@orderloop/core';
import { apiTokens, createDb, users, workspaceSettings } from '@orderloop/db';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { recordAudit } from '../audit';
import * as installs from '../plugin-installs';
import { Refused } from './data';
import { routingOn } from './routing';

type Trail = Record<string, unknown>;

/** The tools the pages ask a step-up for, as the pages decide it (`needsStepUp`, `steppedUp`). */
export async function stepUpNeeded(
  env: Env,
  p: Principal,
  tool: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  switch (tool) {
    case 'approve_plugin':
    case 'rollback_plugin':
    case 'uninstall_plugin':
      return true;
    case 'set_plugin_enabled':
      // An admin API token may still turn a misbehaving plugin off; a person proves it's them.
      return input.enabled === true || p.kind === 'user';
    case 'set_member_role':
      // Making someone an admin gives them this page.
      return input.role === 'admin' && (await roleOf(env, String(input.userId))) !== 'admin';
    default:
      return false;
  }
}

/** Refuses a step-up action whose session hasn't proved its person within `STEP_UP_MS`. */
export function requireSteppedUp(p: Principal, now = Date.now()) {
  if (p.kind !== 'user') throw new Refused('This needs a person signed in, not a token.');
  if (!p.steppedUpAt || now - p.steppedUpAt > STEP_UP_MS) throw new Refused(STEP_UP_NEEDED);
}

async function roleOf(env: Env, id: string): Promise<Role | null> {
  const row = await createDb(env.DB)
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return row && (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : null;
}

async function member(env: Env, id: string) {
  const user = await createDb(env.DB)
    .select({ email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .get();
  if (!user) throw new Refused('That person is no longer on the team.');
  return user;
}

/** Why the team would be left without an admin, or null. */
async function lastAdmin(env: Env, exceptId: string) {
  const other = await createDb(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, exceptId)))
    .get();
  return other
    ? null
    : 'That would leave no admin to manage the team. Make someone else an admin first.';
}

const above = (role: Role) => ROLES.slice(ROLES.indexOf(role) + 1);

export async function previewMemberRole(
  env: Env,
  p: Principal,
  i: { userId: string; role: Role },
  roleBlock?: string,
): Promise<ActionPreview> {
  const user = await member(env, i.userId);
  const lower = ROLES.indexOf(i.role) < ROLES.indexOf(user.role as Role);
  return {
    title: `Make ${boundText(user.name, 80) ?? user.email} ${ROLE_LABELS[i.role]}`,
    href: '/team',
    consequences: [
      `From ${ROLE_LABELS[user.role as Role] ?? user.role} to ${ROLE_LABELS[i.role]}`,
      lower
        ? `Their API tokens above ${ROLE_LABELS[i.role]} are revoked; connected apps follow the new role`
        : 'Connected apps follow the new role',
    ],
    ...((await stepUpNeeded(env, p, 'set_member_role', i)) ? { stepUp: true as const } : {}),
    blocked:
      roleBlock ??
      (user.role === i.role ? `They are already ${ROLE_LABELS[i.role]}.` : undefined) ??
      (i.userId === p.id && i.role !== 'admin'
        ? 'Ask another admin to change your own role.'
        : undefined) ??
      (i.role !== 'admin' ? ((await lastAdmin(env, i.userId)) ?? undefined) : undefined),
  };
}

export async function runMemberRole(
  env: Env,
  p: Principal,
  i: { userId: string; role: Role },
  trail: Trail,
) {
  const user = await member(env, i.userId);
  const db = createDb(env.DB);
  // Taking away the last admin's role is refused in the write itself, so two cards can't each see
  // the other admin and leave none.
  const keeps =
    i.role === 'admin'
      ? undefined
      : sql`exists (select 1 from ${users} as other where other.role = 'admin' and other.disabled_at is null and other.id <> ${i.userId})`;
  const changed = await db
    .update(users)
    .set({ role: i.role })
    .where(and(eq(users.id, i.userId), keeps))
    .returning({ id: users.id });
  if (!changed.length)
    throw new Refused(
      'That would leave no admin to manage the team. Make someone else an admin first.',
    );
  // Lowered: their tokens above the new role end; connected apps follow the role on their own.
  let tokens = 0;
  if (ROLES.indexOf(i.role) < ROLES.indexOf(user.role as Role)) {
    const ended = await db
      .update(apiTokens)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          or(
            eq(apiTokens.createdById, i.userId),
            and(isNull(apiTokens.createdById), eq(apiTokens.createdBy, user.email)),
          ),
          isNull(apiTokens.revokedAt),
          inArray(apiTokens.role, above(i.role)),
        ),
      )
      .returning({ id: apiTokens.id });
    tokens = ended.length;
  }
  await recordAudit(env, 'team.role_changed', {
    actor: p,
    target: user.email,
    detail: { from: user.role, to: i.role, ...(tokens ? { tokens } : {}), ...trail },
  });
  return { done: `${user.name} is now ${ROLE_LABELS[i.role]}`, href: '/team', id: i.userId };
}

async function separationOn(env: Env) {
  const row = await createDb(env.DB)
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY))
    .get();
  return row?.value === 'on';
}

export async function previewApprovalSeparation(
  env: Env,
  on: boolean,
  roleBlock?: string,
): Promise<ActionPreview> {
  return {
    title: on ? 'Keep people from approving their own orders' : 'Let approvers approve any order',
    href: '/team',
    consequences: on
      ? [
          'Whoever started an order can’t decide its approvals',
          'Whoever added a tax certificate can’t verify it',
        ]
      : ['Anyone with the Approver role may approve any order, their own included'],
    blocked:
      roleBlock ?? ((await separationOn(env)) === on ? 'It is already set that way.' : undefined),
  };
}

export async function runApprovalSeparation(env: Env, p: Principal, on: boolean, trail: Trail) {
  const value = on ? 'on' : 'off';
  const updatedBy = p.email ?? p.name;
  await createDb(env.DB)
    .insert(workspaceSettings)
    .values({ key: APPROVAL_SEPARATION_KEY, value, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: Date.now(), updatedBy },
    });
  await recordAudit(env, 'team.approval_separation', {
    actor: p,
    detail: { from: on ? 'off' : 'on', to: value, ...trail },
  });
  return {
    done: on ? 'People can’t approve their own orders' : 'Approvers may approve any order',
    href: '/team',
  };
}

export async function previewRouting(
  env: Env,
  on: boolean,
  roleBlock?: string,
): Promise<ActionPreview> {
  return {
    title: on
      ? 'Route exact requests without the chat model'
      : 'Send every request to the chat model',
    href: '/team',
    consequences: on
      ? [
          'A request that is one exact call (“cancel this order”, “list open carts”) runs on fixed rules when the decision model is sure, so no chat model is paid for',
          'Anything else, and anything it isn’t sure of, goes to the chat model as before',
          'Actions still stop at their confirm card',
        ]
      : ['Every typed request goes to the chat model'],
    blocked:
      roleBlock ?? ((await routingOn(env)) === on ? 'It is already set that way.' : undefined),
  };
}

export async function runRouting(env: Env, p: Principal, on: boolean, trail: Trail) {
  const value = on ? 'on' : 'off';
  const updatedBy = p.email ?? p.name;
  await createDb(env.DB)
    .insert(workspaceSettings)
    .values({ key: ASSISTANT_ROUTING_KEY, value, updatedAt: Date.now(), updatedBy })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedAt: Date.now(), updatedBy },
    });
  await recordAudit(env, 'team.assistant_routing', {
    actor: p,
    detail: { from: on ? 'off' : 'on', to: value, ...trail },
  });
  return {
    done: on
      ? 'Exact requests now run without the chat model'
      : 'Every request goes to the chat model',
    href: '/team',
  };
}

const short = (sha: string) => sha.slice(0, 12);

async function installOf(env: Env, id: string, sha?: string) {
  const all = await installs.listPluginInstalls(env);
  const rows = all.filter((x) => x.id === id);
  if (!rows.length) throw new Refused(`${id} is not installed at runtime.`);
  const row = sha
    ? rows.find((x) => x.sha === sha)
    : (rows.find((x) => x.status === 'active' || x.status === 'disabled') ?? rows[0]);
  if (!row) throw new Refused(`${id} has no version ${short(sha ?? '')}.`);
  return row;
}

export type PluginChange =
  | { tool: 'set_plugin_enabled'; pluginId: string; enabled: boolean }
  | { tool: 'approve_plugin'; pluginId: string; sha: string; personalData?: boolean }
  | { tool: 'rollback_plugin'; pluginId: string; sha: string }
  | { tool: 'uninstall_plugin'; pluginId: string };

export async function previewPlugin(
  env: Env,
  p: Principal,
  c: PluginChange,
  roleBlock?: string,
): Promise<ActionPreview> {
  const row = await installOf(env, c.pluginId, 'sha' in c ? c.sha : undefined);
  const steps = row.manifest.nodes.map((n) => n.label).join(', ');
  const base = { href: '/plugins' };
  const always = { ...base, stepUp: true as const };
  const stepUp = (await stepUpNeeded(env, p, c.tool, c as never)) ? { stepUp: true as const } : {};
  switch (c.tool) {
    case 'set_plugin_enabled':
      return {
        ...base,
        ...stepUp,
        title: `${c.enabled ? 'Turn on' : 'Turn off'} ${c.pluginId} ${row.version}`,
        consequences: c.enabled
          ? [`Its steps run again in flows that use them${steps ? `: ${steps}` : ''}`]
          : [
              'Flows that use it can’t be published, and their running steps fail',
              ...(steps ? [`Its steps: ${steps}`] : []),
            ],
        blocked:
          roleBlock ??
          (row.status === (c.enabled ? 'active' : 'disabled')
            ? `It is already ${c.enabled ? 'on' : 'off'}.`
            : undefined),
      };
    case 'approve_plugin':
      return {
        ...always,
        title: `Install ${c.pluginId} ${row.version}`,
        consequences: [
          `From ${row.publisher}; it runs on every order whose flow uses its steps${steps ? `: ${steps}` : ''}`,
          row.manifest.personalData === 'send'
            ? c.personalData
              ? 'It gets buyers’ details (names, addresses, emails)'
              : 'It asks for buyers’ details, which aren’t granted: it can’t be installed without them'
            : 'It never gets buyers’ details',
          ...(row.manifest.secrets.length
            ? [`Secrets it uses: ${row.manifest.secrets.map((s) => s.name).join(', ')}`]
            : []),
        ],
        blocked: roleBlock ?? (row.status !== 'pending' ? `It is ${row.status}.` : undefined),
      };
    case 'rollback_plugin':
      return {
        ...always,
        title: `Roll ${c.pluginId} back to ${row.version}`,
        consequences: [
          `Version ${row.version} (${short(row.sha)}) runs again in place of the current one`,
          'Orders already running finish on the version they started with',
        ],
        blocked:
          roleBlock ??
          (row.status !== 'superseded'
            ? 'Only an earlier version can be rolled back to.'
            : undefined),
      };
    case 'uninstall_plugin':
      return {
        ...always,
        title: `Uninstall ${c.pluginId}`,
        consequences: [
          'Its steps stop running; flows that use them can’t be published',
          'Its secrets are deleted; its data stays in its own database',
        ],
        blocked: roleBlock,
      };
  }
}

export async function runPlugin(env: Env, p: Principal, c: PluginChange, trail: Trail) {
  const by = p.email ?? p.name;
  const answer = async <T>(run: () => Promise<T>) => {
    const r = await installs.refusable(run);
    if (!r.ok) {
      // A refused change is on the record, as it is from the Plugins page.
      await recordAudit(env, 'plugin.refused', {
        actor: p,
        target: c.pluginId,
        detail: { tool: c.tool, error: r.error, ...trail },
      });
      throw new Refused(r.error);
    }
    return r.value;
  };
  switch (c.tool) {
    case 'set_plugin_enabled': {
      await answer(() => installs.setPluginEnabled(env, c.pluginId, c.enabled));
      await recordAudit(env, c.enabled ? 'plugin.enabled' : 'plugin.disabled', {
        actor: p,
        target: c.pluginId,
        detail: trail,
      });
      return {
        done: c.enabled ? `${c.pluginId} is running again` : `${c.pluginId} is off`,
        href: '/plugins',
        id: c.pluginId,
      };
    }
    case 'approve_plugin': {
      const v = await answer(() =>
        installs.approvePlugin(env, c.pluginId, c.sha, { personalData: !!c.personalData }, by),
      );
      await recordAudit(env, 'plugin.approved', {
        actor: p,
        target: c.pluginId,
        detail: { version: v.version, sha: short(v.sha), personalData: v.personalData, ...trail },
      });
      return {
        done: `${c.pluginId} ${v.version} is installed and running`,
        href: '/plugins',
        id: c.pluginId,
      };
    }
    case 'rollback_plugin': {
      const v = await answer(() => installs.rollbackPlugin(env, c.pluginId, c.sha));
      await recordAudit(env, 'plugin.rolled_back', {
        actor: p,
        target: c.pluginId,
        detail: { version: v.version, sha: short(c.sha), ...trail },
      });
      return {
        done: `${c.pluginId} is back to version ${v.version}`,
        href: '/plugins',
        id: c.pluginId,
      };
    }
    case 'uninstall_plugin': {
      await answer(() => installs.uninstallPlugin(env, c.pluginId));
      await recordAudit(env, 'plugin.uninstalled', { actor: p, target: c.pluginId, detail: trail });
      return { done: `${c.pluginId} is uninstalled`, href: '/plugins', id: c.pluginId };
    }
  }
}

/** Runs a draft's test cases on the bundle that would run; changes nothing. */
export async function runCases(
  env: Env,
  p: Principal,
  i: { pluginId: string; sha: string; cases: PluginCase[] },
  trail: Trail,
) {
  const r = await installs.refusable(() =>
    installs.runPluginCases(env, i.pluginId, i.sha, i.cases),
  );
  if (!r.ok) throw new Refused(r.error);
  const passed = r.value.filter((c) => c.pass).length;
  await recordAudit(env, 'plugin.cases_run', {
    actor: p,
    target: i.pluginId,
    detail: { cases: `${passed}/${r.value.length}`, ...trail },
  });
  return {
    done:
      passed === r.value.length
        ? `All ${passed} cases pass`
        : `${passed} of ${r.value.length} cases pass`,
    href: '/plugins',
    id: i.pluginId,
    results: r.value,
  };
}
