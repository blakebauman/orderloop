/**
 * An admin's runtime plugin installs, from the Plugins page and the REST API: upload a signed
 * `.olplugin` for review, approve it, set its secrets, turn it off and on, roll it back, uninstall
 * it. The engine checks the bundle (publisher, signature, sha, its sealed manifest) and refuses
 * what it can't trust; this side checks the caller. Approving, rolling back and uninstalling need a
 * step-up (`stepUp`), since each changes what code runs on every order. Every change is audited,
 * and so is every refusal. See docs/plugins.md, "Installing at runtime".
 */

import {
  type AuditActor,
  PLUGIN_BUNDLE_MAX_BYTES,
  PLUGIN_ID_RE,
  type Principal,
  type Refusable,
} from '@orderloop/core';
import type { AuditAction } from './audit';
import { audit } from './audit.server';
import { stepUp } from './auth.server';
import { engine } from './env.server';

/** A Plugins page form: the bundle, and room for the other fields of a multipart body. */
export const PLUGIN_FORM_MAX_BYTES = PLUGIN_BUNDLE_MAX_BYTES + 64 * 1024;

const INTENTS = [
  'upload',
  'approve',
  'secret',
  'disable',
  'enable',
  'rollback',
  'uninstall',
] as const;
export type PluginIntent = (typeof INTENTS)[number];
export const isPluginIntent = (v: unknown): v is PluginIntent =>
  INTENTS.includes(v as PluginIntent);

/**
 * The intents that change what runs on every order, so need the admin to prove it's them. Setting
 * a secret does too once the plugin runs (a replaced key could send its calls to another account);
 * before approval, approving is the check.
 */
const STEPPED_UP: ReadonlySet<PluginIntent> = new Set([
  'approve',
  'rollback',
  'uninstall',
  'enable',
]);

const running = async (id: string) =>
  (await engine().listPluginInstalls()).some(
    (i) => i.id === id && (i.status === 'active' || i.status === 'disabled'),
  );

export type PluginActionResult =
  | { ok: true; done: string; reviewing?: string }
  | { ok: false; error: string };

const short = (sha: string) => sha.slice(0, 12);

/** Runs one Plugins page intent for an admin `by`. `f` is the form, its bundle a file or text. */
export async function pluginAction(
  request: Request,
  by: Principal & AuditActor,
  f: FormData,
): Promise<PluginActionResult> {
  const str = (k: string) => {
    const v = f.get(k);
    return typeof v === 'string' ? v : '';
  };
  const intent = str('intent');
  if (!isPluginIntent(intent)) return { ok: false, error: 'Unknown action.' };
  const id = str('id');
  if (intent !== 'upload' && !PLUGIN_ID_RE.test(id)) return { ok: false, error: 'Unknown plugin.' };
  const refused = async (error: string) => {
    await audit(request, 'plugin.refused', {
      actor: by,
      target: id || null,
      detail: { intent, error },
    });
    return { ok: false as const, error };
  };
  if (STEPPED_UP.has(intent) || (intent === 'secret' && (await running(id)))) {
    const failed = await stepUp(request, by, { code: str('code'), password: str('password') });
    if (failed) return refused(failed);
  }
  const answered = async <T>(
    call: Promise<Refusable<T>>,
    action: AuditAction,
    detail: (v: T) => Record<string, unknown>,
    target = id,
  ) => {
    const r = await call;
    if (!r.ok) return { refusal: await refused(r.error) };
    await audit(request, action, { actor: by, target, detail: detail(r.value) });
    return { value: r.value };
  };
  switch (intent) {
    case 'upload': {
      const file = f.get('bundle');
      const text = typeof file === 'string' ? file : file ? await file.text() : '';
      if (!text) return { ok: false, error: 'Choose a .olplugin file.' };
      const r = await uploadBundle(request, by, text);
      if (!r.ok) return r;
      return {
        ok: true,
        done: `${r.value.id} ${r.value.version} is uploaded. Review what it asks for, then approve it.`,
        reviewing: `${r.value.id}:${r.value.sha}`,
      };
    }
    case 'approve': {
      const r = await answered(
        engine().approvePlugin(
          id,
          str('sha'),
          { personalData: str('personalData') === 'on' },
          by.id,
        ),
        'plugin.approved',
        (v) => ({ version: v.version, sha: short(v.sha), personalData: v.personalData }),
      );
      return r.refusal ?? { ok: true, done: `${id} ${r.value.version} is installed and running.` };
    }
    case 'secret': {
      const name = str('name');
      const r = await answered(
        engine().setPluginSecret(id, name, str('value'), by.id),
        'plugin.secret_set',
        () => ({ secret: name }),
      );
      return r.refusal ?? { ok: true, done: `${id}’s ${name} is set.` };
    }
    case 'disable':
    case 'enable': {
      const on = intent === 'enable';
      const r = await answered(
        engine().setPluginEnabled(id, on),
        on ? 'plugin.enabled' : 'plugin.disabled',
        () => ({}),
      );
      return (
        r.refusal ?? {
          ok: true,
          done: on
            ? `${id} is running again.`
            : `${id} is off: flows that use it can’t be published, and running steps fail.`,
        }
      );
    }
    case 'rollback': {
      const r = await answered(
        engine().rollbackPlugin(id, str('sha')),
        'plugin.rolled_back',
        (v) => ({
          version: v.version,
          sha: short(str('sha')),
        }),
      );
      return r.refusal ?? { ok: true, done: `${id} is back to version ${r.value.version}.` };
    }
    case 'uninstall': {
      const r = await answered(engine().uninstallPlugin(id), 'plugin.uninstalled', () => ({}));
      return (
        r.refusal ?? {
          ok: true,
          done: `${id} is uninstalled; its secrets and storage are deleted.`,
        }
      );
    }
  }
}

/** Uploads a `.olplugin` for review (the page's and the REST API's), audited either way. */
export async function uploadBundle(
  request: Request,
  by: Principal & AuditActor,
  text: string,
): ReturnType<ReturnType<typeof engine>['uploadPlugin']> {
  if (text.length > PLUGIN_BUNDLE_MAX_BYTES) {
    const error = `A plugin bundle is at most ${PLUGIN_BUNDLE_MAX_BYTES / 1024 / 1024} MiB`;
    await audit(request, 'plugin.refused', { actor: by, detail: { intent: 'upload', error } });
    return { ok: false, error };
  }
  const r = await engine().uploadPlugin(text, by.id);
  if (!r.ok)
    await audit(request, 'plugin.refused', {
      actor: by,
      detail: { intent: 'upload', error: r.error },
    });
  else
    await audit(request, 'plugin.uploaded', {
      actor: by,
      target: r.value.id,
      detail: { version: r.value.version, sha: short(r.value.sha), publisher: r.value.publisher },
    });
  return r;
}
