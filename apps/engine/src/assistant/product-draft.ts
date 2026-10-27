/**
 * The assistant drafts a catalog product's missing text (`draft_product_content`): titles,
 * descriptions, text attributes and image alt text, locale by locale, from what the product says
 * in its other locales. The product reaches the model only inside a data block: a feed wrote it.
 *
 * Drafts are saved on the product (`putDrafts`) and never go live from here. A person accepts one
 * by staging it, and it goes live only when they publish; the catalog checks every draft as it
 * would an edit. See docs/product-editor.md.
 */

import {
  ASSISTANT_BUDGET_SPENT,
  type AuditVia,
  boundText,
  DATA_RULES,
  dataBlock,
  type Principal,
} from '@orderloop/core';
import {
  draftRefIssue,
  draftTargets,
  type FieldRef,
  fieldId,
  fieldLocales,
  type Localized,
  MAX_DRAFT_FIELDS,
  type Media,
  PRODUCT_DRAFT_INSTRUCTION_MAX,
  type Product,
  type ProductCatalogRpc,
  type ProductDraftRequest,
  type ProductDraftResult,
  TEXT_MAX,
} from '@orderloop/core/product';
import { runJson } from '../ai';
import { recordAudit } from '../audit';
import { assistantBudgetSpent, recordAssistantUsage } from '../usage';
import { Refused } from './data';
import { DRAFT_MODEL_OPTIONS, DRAFT_TIMEOUT_MS } from './plugin-draft';

/** The catalog Worker, typed by its RPC contract. */
export const catalog = (env: Env) => env.CATALOG as unknown as ProductCatalogRpc;

const SYSTEM = [
  'You write product content for a catalog. For each field and locale asked for, write its value in that locale from what the product says: translate its text in other locales faithfully, keeping product names, brands, model numbers, units and numbers as they are.',
  'Never add features, materials, measurements, certifications or claims the product does not state. If the product says too little to write a field, leave that field out.',
  'Field ids: "title", "description", "slug", "attr:<code>" (that text attribute), "alt:#<n>" (the alt text of the image whose n it is). A slug is lowercase ASCII words joined by "-", from the title in that locale. Alt text is one short phrase saying what the image shows.',
  'Answer JSON: { "drafts": [{ "field": "<field id>", "locale": "<locale>", "value": "<text>" }] }, one per field and locale asked for, and none other.',
  DATA_RULES,
].join('\n\n');

const SCHEMA = {
  type: 'object',
  required: ['drafts'],
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'locale', 'value'],
        properties: {
          field: { type: 'string' },
          locale: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
};

type Answer = { drafts: { field?: unknown; locale?: unknown; value?: unknown }[] };

/** The product's text, every locale of it, as the model reads it. Prices and variants stay out. */
export function contentView(p: Product) {
  const attributes: Record<string, Localized> = {};
  for (const [code, v] of Object.entries(p.attributes))
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isText))
      attributes[code] = v as Localized;
  return {
    title: p.title,
    ...(p.description ? { description: p.description } : {}),
    ...(p.slug ? { slug: p.slug } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...(p.media.length
      ? { media: p.media.map((m, n) => ({ n, src: m.src, alt: m.alt ?? {} })) }
      : {}),
  };
}

const isText = (v: unknown) => typeof v === 'string';

/** Locales match whatever their case: `fr-ca` answers `fr-CA`. */
const key = (field: string, locale: string) => `${field}\u0000${locale.toLowerCase()}`;

/**
 * A field as the prompt names it: its `fieldId`, but an image by its position (`alt:#2`). A media
 * `src` is the feed's text, so it reaches the model only inside the data block.
 */
export function promptField(ref: FieldRef, media: readonly Media[]): string {
  if (ref.field !== 'mediaAlt') return fieldId(ref);
  return `alt:#${media.findIndex((m) => m.src === ref.src)}`;
}

/**
 * The model's drafts held to what was asked: one per field and locale asked for, the first it
 * wrote; control characters gone (a description keeps its line breaks), cut to `TEXT_MAX`. A
 * field it left out or left empty comes back in `missing`.
 */
export function boundDrafts(
  answer: Answer,
  targets: FieldRef[],
  media: readonly Media[] = [],
): { drafted: { ref: FieldRef; value: string }[]; missing: FieldRef[] } {
  const wanted = new Map(targets.map((r) => [key(promptField(r, media), r.locale ?? ''), r]));
  const got = new Map<string, string>();
  for (const d of Array.isArray(answer?.drafts) ? answer.drafts : []) {
    if (typeof d?.field !== 'string' || typeof d.locale !== 'string') continue;
    const k = key(d.field, d.locale);
    const ref = wanted.get(k);
    if (!ref || got.has(k)) continue;
    const value = ref.field === 'description' ? boundBlock(d.value) : boundText(d.value, TEXT_MAX);
    if (value) got.set(k, ref.field === 'slug' ? value.toLowerCase() : value);
  }
  const drafted: { ref: FieldRef; value: string }[] = [];
  const missing: FieldRef[] = [];
  for (const [k, ref] of wanted) {
    const value = got.get(k);
    if (value) drafted.push({ ref, value });
    else missing.push(ref);
  }
  return { drafted, missing };
}

/** Text that may run over lines: control characters but line breaks gone, trimmed, cut to `TEXT_MAX`. */
function boundBlock(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const s = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, TEXT_MAX) : null;
}

const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 200);

/**
 * In mock mode, without the model: each field from its text in another locale, marked with the
 * locale it is for, and a slug from the title. Never a stand-in for a failed model call.
 */
export function heuristicDrafts(p: Product, targets: FieldRef[]): Answer {
  const first = (l: Localized) =>
    Object.keys(l)
      .sort()
      .map((x) => l[x])[0];
  return {
    drafts: targets.flatMap((ref) => {
      const locale = ref.locale ?? '';
      const source =
        ref.field === 'slug'
          ? first(p.title)
          : (first(fieldLocales(p, ref)) ??
            (ref.field === 'mediaAlt' ? first(p.title) : undefined));
      if (!source) return [];
      const value = ref.field === 'slug' ? slugify(source) : `[${locale}] ${source}`;
      return value ? [{ field: promptField(ref, p.media), locale, value }] : [];
    }),
  };
}

/**
 * Drafts `request`'s fields of product `key` (or its draftable gaps) and saves them on the product.
 * Refused for a product the catalog doesn't have, when there's nothing to draft, when the person's
 * assistant tokens are spent for the day, and when the model call fails. With `via` (the assistant,
 * MCP, A2A) the drafts are audited here; the web app's route audits its own.
 */
export async function draftProductContent(
  env: Env,
  p: Principal,
  key: string,
  request: ProductDraftRequest,
  via?: AuditVia,
): Promise<ProductDraftResult> {
  const c = catalog(env);
  const sheet = await c.getProductSheet(key);
  if (!sheet) throw new Refused(`The catalog has no product ${boundText(key, 100) ?? ''}.`);
  const product = sheet.product;
  const title =
    Object.keys(product.title)
      .sort()
      .map((l) => product.title[l])[0] ?? key;
  // The web app and the tool schema cap `fields`; the RPC path is held to the same.
  const fields = request.fields?.slice(0, MAX_DRAFT_FIELDS);
  const refused: ProductDraftResult['refused'] = (fields ?? []).flatMap((ref) => {
    const issue = draftRefIssue(ref);
    return issue ? [{ ref, issues: [issue] }] : [];
  });
  // A gap that already has a draft or a staged edit waits for a person, not another draft.
  const pending = [...sheet.drafts, ...sheet.staged].map((d) => d.ref);
  const { targets, more } = draftTargets(sheet.gaps, fields, pending);
  if (!targets.length) {
    if (refused.length) return { key, title, drafted: [], refused, more: 0, model: null };
    throw new Refused(
      `${title} has no missing text left to draft: its gaps have drafts or staged edits waiting, or it has none. Name the fields and locales to draft them again.`,
    );
  }
  if (await assistantBudgetSpent(env, p)) throw new Refused(ASSISTANT_BUDGET_SPENT);

  const asked = targets.map((r) => ({ field: promptField(r, product.media), locale: r.locale }));
  const instruction = boundText(request.instruction, PRODUCT_DRAFT_INSTRUCTION_MAX);
  const answer = await runJson<Answer>(
    env,
    'product_draft',
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          `Draft these fields: ${JSON.stringify(asked)}`,
          ...(instruction ? [`The person asking adds: ${instruction}`] : []),
          dataBlock('product', contentView(product)),
        ].join('\n\n'),
      },
    ],
    SCHEMA,
    () => heuristicDrafts(product, targets),
    {
      model: String(env.ASSISTANT_MODEL),
      maxTokens: 8192,
      timeoutMs: DRAFT_TIMEOUT_MS,
      input: DRAFT_MODEL_OPTIONS.input,
    },
  );
  // What the model used counts even when its answer can't be used.
  if (answer.tokens !== undefined) await recordAssistantUsage(env, p, answer.tokens);
  // Only mock mode drafts without the model: a failed call must not pass off marked-up copies.
  if (answer.source === 'heuristic' && answer.fallback !== 'mock')
    throw new Refused(`The model couldn’t draft that (${answer.fallback}). Try again.`);

  const { drafted, missing } = boundDrafts(answer.value, targets, product.media);
  for (const ref of missing)
    refused.push({ ref, issues: ['the product says too little to write it from'] });
  const results = drafted.length
    ? await c.putDrafts(
        drafted.map((d) => ({
          key,
          ref: d.ref,
          value: d.value,
          model: answer.model ?? 'heuristic',
        })),
        p.email ?? p.name,
      )
    : [];
  const saved: ProductDraftResult['drafted'] = [];
  results.forEach((r, i) => {
    const d = drafted[i];
    if (!d) return;
    if (r.ok) saved.push(d);
    else refused.push({ ref: d.ref, issues: r.issues });
  });
  if (via && saved.length)
    await recordAudit(env, 'catalog.drafts_saved', {
      actor: p,
      target: key,
      detail: { saved: saved.length, refused: refused.length, model: answer.model, via },
    });
  return { key, title, drafted: saved, refused, more, model: answer.model };
}
