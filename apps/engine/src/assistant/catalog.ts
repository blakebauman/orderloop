/**
 * The Catalog page's writes through the assistant: staging edits, accepting the assistant's drafts,
 * discarding staged edits or drafts, and publishing. Staging, accepting and discarding change only
 * what waits to publish, and each overwrites or drops what a person was working on, so only the
 * page's own buttons make them (`PAGE_ONLY_TOOLS`): a model drafts instead
 * (`draft_product_content`), and a person accepts. Publishing changes the live catalog, so it
 * stops for a confirm, held to the staged edits its card listed.
 */

import { type ActionPreview, boundText, fingerprintOf, type Principal } from '@orderloop/core';
import type { FieldRef, StageEdit } from '@orderloop/core/product';
import { recordAudit } from '../audit';
import type { Confirmed } from './data';
import { Refused } from './data';
import { catalog } from './product-draft';

type Trail = Record<string, unknown>;

const by = (p: Principal) => p.email ?? p.id;

/** Stages edits as `p`; answers per edit. Accepting a draft is staging it with `source: 'assistant'`. */
export async function stageProductEdits(env: Env, p: Principal, edits: StageEdit[], trail: Trail) {
  const results = await catalog(env).stageEdits(edits, by(p));
  const staged = results.filter((r) => r.ok);
  if (results.length)
    await recordAudit(env, 'catalog.edits_staged', {
      actor: p,
      detail: {
        staged: staged.length,
        refused: results.length - staged.length,
        products: new Set(staged.map((r) => r.key)).size,
        fromDrafts: edits.filter((e, i) => e.source === 'assistant' && results[i]?.ok).length,
        ...trail,
      },
    });
  return {
    done: `Staged ${staged.length} of ${results.length} edit${results.length === 1 ? '' : 's'}`,
    href: '/catalog',
    results,
  };
}

/** Stages each of a product's drafts that the field hasn't moved past, as the assistant's text. */
export async function acceptProductDrafts(env: Env, p: Principal, key: string, trail: Trail) {
  const sheet = await catalog(env).getProductSheet(key);
  if (!sheet) throw new Refused(`No product has the key ${key}.`);
  const fresh = sheet.drafts.filter((d) => !d.stale);
  if (!fresh.length) throw new Refused('Nothing drafted is left to accept.');
  return stageProductEdits(
    env,
    p,
    fresh.map((d) => ({ key, ref: d.ref, op: 'set', value: d.value, source: 'assistant' })),
    trail,
  );
}

/** Drops staged edits or drafts: one field's, or with no `ref` all of a product's. */
export async function discardProductEdits(
  env: Env,
  p: Principal,
  what: 'staged' | 'drafts',
  items: { key: string; ref?: FieldRef }[],
  trail: Trail,
) {
  const c = catalog(env);
  const r =
    what === 'staged' ? await c.discardStaged(items, by(p)) : await c.discardDrafts(items, by(p));
  await recordAudit(
    env,
    what === 'staged' ? 'catalog.edits_discarded' : 'catalog.drafts_discarded',
    {
      actor: p,
      detail: { discarded: r.discarded, ...trail },
    },
  );
  return { done: `Discarded ${r.discarded}`, href: '/catalog', discarded: r.discarded };
}

/** What publishing these products would publish: each one's staged edits, as the catalog has them. */
async function stagedOf(env: Env, keys: string[]) {
  const sheets = await Promise.all(keys.map((k) => catalog(env).getProductSheet(k)));
  return keys.map((key, i) => ({
    key,
    title: titleOf(sheets[i]?.product.title),
    staged: (sheets[i]?.staged ?? []).map((s) => ({
      ref: s.ref,
      op: s.op,
      value: s.value,
      at: s.at,
    })),
  }));
}

/** A product's title for the card: its English text, else its first; one bounded line. */
const titleOf = (t: unknown) => {
  if (typeof t === 'string') return boundText(t, 60);
  const m = (t ?? {}) as Record<string, unknown>;
  return boundText(m.en ?? Object.values(m)[0], 60);
};

const fieldsOf = (staged: { ref: FieldRef }[]) =>
  [...new Set(staged.map((s) => (s.ref as { field?: string }).field ?? 'a field'))].join(', ');

export async function previewPublishCatalog(
  env: Env,
  keys: string[],
  roleBlock?: string,
): Promise<ActionPreview> {
  const rows = await stagedOf(env, [...new Set(keys)]);
  const going = rows.filter((r) => r.staged.length);
  const edits = going.reduce((n, r) => n + r.staged.length, 0);
  return {
    title: `Publish ${going.length} product${going.length === 1 ? '' : 's'}`,
    href: '/catalog',
    consequences: [
      `${edits} staged edit${edits === 1 ? ' goes' : 's go'} live on the storefront and in the feeds`,
      ...going
        .slice(0, 6)
        .map((r) => `${r.key}${r.title ? ` “${r.title}”` : ''}: ${fieldsOf(r.staged)}`),
      ...(going.length > 6 ? [`and ${going.length - 6} more`] : []),
      ...(rows.length > going.length
        ? [`${rows.length - going.length} with nothing staged are left as they are`]
        : []),
      'Each product publishes all of its edits or none: one changed by someone else since is refused',
    ],
    bound: { staged: await fingerprintOf(rows) },
    blocked: roleBlock ?? (going.length ? undefined : 'Nothing staged to publish.'),
  };
}

export const STAGED_CHANGED = 'The staged edits changed since you confirmed; look at them again.';

export async function runPublishCatalog(
  env: Env,
  p: Principal,
  keys: string[],
  key: string | undefined,
  trail: Trail,
  confirmed?: Confirmed,
) {
  const unique = [...new Set(keys)];
  // Held to what the card listed: something staged since would publish unseen. A confirm held to
  // nothing (a card never shown, or shown differently since) is refused too, as a cart submit is;
  // only a typed A2A call, which the caller composed itself, isn't held.
  if (confirmed !== 'direct') {
    const held = confirmed?.bound?.staged;
    if (typeof held !== 'string' || held !== (await fingerprintOf(await stagedOf(env, unique))))
      throw new Refused(STAGED_CHANGED);
  }
  const requestId = `assistant:${p.id}:${key ?? crypto.randomUUID()}`;
  const results = await catalog(env).publishStaged(unique, { by: by(p), requestId });
  const count = (s: (typeof results)[number]['status']) =>
    results.filter((r) => r.status === s).length;
  await recordAudit(env, 'catalog.edits_published', {
    actor: p,
    detail: {
      published: count('published'),
      failed: count('failed'),
      unchanged: count('unchanged'),
      keys: results
        .filter((r) => r.status === 'published')
        .map((r) => r.key)
        .slice(0, 50),
      requestId,
      urgent: false,
      ...trail,
    },
  });
  return {
    done: `Published ${count('published')} of ${unique.length}`,
    href: '/catalog',
    results,
  };
}
