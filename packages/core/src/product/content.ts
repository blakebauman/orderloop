/**
 * A stored product's content, field by field and locale by locale: what a person (or the assistant)
 * can edit, and the gaps a product leaves in the channels it is listed in. An edit is kept as an
 * override over the feed's version of the product (`applyOverrides`), so the next import doesn't
 * wipe it; the catalog shard stores both and re-applies the overrides on every write. Pure.
 */

import { z } from 'zod';
import {
  type Channel,
  type Localized,
  PRODUCT_STATUSES,
  type ProductData,
  type ProductType,
} from './model';
import { LOCALE, SLUG } from './paths';

/**
 * The fields the editor writes. Content only: variants, prices, channels, categories and media
 * stay with the feed. `attribute` is a product-scoped, localized text attribute; `mediaAlt` is the
 * alt text of one of the product's media, named by its `src`.
 */
export const EDITABLE_FIELDS = [
  'title',
  'description',
  'slug',
  'status',
  'attribute',
  'mediaAlt',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** One editable value: a field, the attribute or media it names, and its locale (not for status). */
export type FieldRef = {
  field: EditableField;
  /** `attribute` only: the attribute's code. */
  code?: string;
  /** `mediaAlt` only: the media's `src`. */
  src?: string;
  /** Every field but `status`. */
  locale?: string;
};

/** A `FieldRef` as a request sends it. Shape only: the catalog checks it against the product. */
export const fieldRefSchema = z.object({
  field: z.enum(EDITABLE_FIELDS),
  code: z.string().min(1).max(128).optional().describe('`attribute` only: the attribute’s code'),
  src: z.string().min(1).max(2048).optional().describe('`mediaAlt` only: the image’s src'),
  locale: z.string().min(1).max(35).optional().describe('Every field but `status`, e.g. fr-CA'),
});

/** An edit as stored: the value it sets, or null to remove the feed's value in that locale. */
export type Override = { ref: FieldRef; value: string | null };

/** An override as the catalog keeps it: with the feed value it was made against (`base`). */
export type BasedOverride = Override & { base: string | null };

/** Longest text a localized value may hold (`localizedSchema`). */
export const TEXT_MAX = 10_000;
/** Longest slug (`validateProduct`). */
export const SLUG_MAX = 200;

/** A field as one string, for storage and the sheet's per-field maps: `title`, `attr:care`, `alt:<src>`. */
export function fieldId(ref: FieldRef): string {
  if (ref.field === 'attribute') return `attr:${ref.code ?? ''}`;
  if (ref.field === 'mediaAlt') return `alt:${ref.src ?? ''}`;
  return ref.field;
}

/** The field a `fieldId` names (without its locale), or null if it names none. */
export function parseFieldId(id: string): Omit<FieldRef, 'locale'> | null {
  if (id.startsWith('attr:'))
    return id.length > 5 ? { field: 'attribute', code: id.slice(5) } : null;
  if (id.startsWith('alt:')) return id.length > 4 ? { field: 'mediaAlt', src: id.slice(4) } : null;
  return (EDITABLE_FIELDS as readonly string[]).includes(id) &&
    id !== 'attribute' &&
    id !== 'mediaAlt'
    ? { field: id as EditableField }
    : null;
}

const localized = (v: unknown): Localized | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Localized) : undefined;

/** The value of one field in one locale (status has none), or null when it has none. */
export function fieldValue(data: ProductData, ref: FieldRef): string | null {
  const at = (l: Localized | undefined) => (ref.locale ? (l?.[ref.locale] ?? null) : null);
  switch (ref.field) {
    case 'status':
      return data.status;
    case 'title':
      return at(data.title);
    case 'description':
      return at(data.description);
    case 'slug':
      return at(data.slug);
    case 'attribute':
      return at(localized(data.attributes[ref.code ?? '']));
    case 'mediaAlt':
      return at(data.media.find((m) => m.src === ref.src)?.alt);
  }
}

/** `l` with `locale` set to `value`, or removed for null; undefined when nothing is left. */
function setLocale(l: Localized | undefined, locale: string, value: string | null) {
  const next = { ...l };
  if (value === null) delete next[locale];
  else next[locale] = value;
  return Object.keys(next).length ? next : undefined;
}

/**
 * The product as it goes live: the feed's version with every override applied. An override whose
 * attribute or media the feed no longer has is skipped; the shard reports it as a conflict.
 */
export function applyOverrides(feed: ProductData, overrides: Override[]): ProductData {
  if (!overrides.length) return feed;
  const out: ProductData = {
    ...feed,
    attributes: { ...feed.attributes },
    media: feed.media.map((m) => ({ ...m })),
  };
  for (const { ref, value } of overrides) {
    const locale = ref.locale ?? '';
    switch (ref.field) {
      case 'status':
        if (value && (PRODUCT_STATUSES as readonly string[]).includes(value))
          out.status = value as ProductData['status'];
        break;
      case 'title': {
        // Never the last title: a feed can drop the other locales after the override was made.
        const next = setLocale(out.title, locale, value);
        if (next) out.title = next;
        break;
      }
      case 'description':
        out.description = setLocale(out.description, locale, value);
        if (!out.description) delete out.description;
        break;
      case 'slug':
        out.slug = setLocale(out.slug, locale, value);
        if (!out.slug) delete out.slug;
        break;
      case 'attribute': {
        const code = ref.code ?? '';
        const next = setLocale(localized(out.attributes[code]), locale, value);
        if (next) out.attributes[code] = next;
        else delete out.attributes[code];
        break;
      }
      case 'mediaAlt': {
        const m = out.media.find((x) => x.src === ref.src);
        if (!m) break;
        m.alt = setLocale(m.alt, locale, value);
        if (!m.alt) delete m.alt;
        break;
      }
    }
  }
  return out;
}

/**
 * Whether the feed changed a value under an override since it was made: the feed's value now isn't
 * the one the override was made against, or the media it names is gone. The override stays live;
 * the product goes back on the board until someone keeps it, takes the feed's value or writes anew.
 */
export function overrideConflict(feed: ProductData, o: BasedOverride): boolean {
  if (o.ref.field === 'mediaAlt' && !feed.media.some((m) => m.src === o.ref.src)) return true;
  return fieldValue(feed, o.ref) !== o.base;
}

/**
 * Why an edit can't be made to `data` (the product as it stands), or an empty list. `type` is the
 * product's pinned type version: only its product-scoped, localized text attributes are editable.
 */
export function editIssues(data: ProductData, type: ProductType, edit: Override): string[] {
  const { ref, value } = edit;
  const issues: string[] = [];
  if (!(EDITABLE_FIELDS as readonly string[]).includes(ref.field)) return ['not an editable field'];
  if (ref.field === 'status') {
    if (value === null || !(PRODUCT_STATUSES as readonly string[]).includes(value))
      issues.push(`status must be one of ${PRODUCT_STATUSES.join(', ')}`);
    return issues;
  }
  if (!ref.locale || !LOCALE.test(ref.locale)) issues.push('needs a locale');
  if (value !== null && value.length > TEXT_MAX) issues.push(`over ${TEXT_MAX} characters`);
  if (value !== null && !value.trim()) issues.push('empty: remove the value instead');
  switch (ref.field) {
    case 'title':
      if (value === null && Object.keys(data.title).every((l) => l === ref.locale))
        issues.push('a product needs a title in at least one locale');
      break;
    case 'slug':
      if (value !== null && (value.length > SLUG_MAX || !SLUG.test(value)))
        issues.push('lowercase words joined by "-"');
      break;
    case 'attribute': {
      const a = type.attributes.find((x) => x.code === ref.code);
      if (!a) issues.push(`no attribute ${ref.code ?? ''} in ${type.code}@${type.version}`);
      else if (a.kind !== 'text' || !a.localized || a.scope !== 'product')
        issues.push(`${a.code} isn't product text with a value per locale`);
      else if (
        a.required &&
        value === null &&
        Object.keys(localized(data.attributes[a.code]) ?? {}).every((l) => l === ref.locale)
      )
        issues.push(`${a.code} is required in at least one locale`);
      break;
    }
    case 'mediaAlt':
      if (!data.media.some((m) => m.src === ref.src)) issues.push('no such media');
      break;
  }
  return issues;
}

/**
 * Kinds of gap the board shows. The content kinds come from `contentGaps`; the catalog adds
 * `rejected` (a feed row it refused), `missing_required` (refused for a required attribute: a
 * stored product always has them) and `conflict` (the feed changed a value under an override).
 */
export const GAP_KINDS = [
  'missing_title',
  'missing_description',
  'missing_attribute',
  'missing_alt',
  'missing_required',
  'rejected',
  'conflict',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** Something a product lacks: a field (`fieldId`) in a locale of a channel it is listed in. */
export type Gap = { kind: GapKind; field: string; locale: string; channel: string };

/**
 * The content gaps of a product in the channels it is visible in, locale by locale, by exact
 * locale (publishing would fall back to the default locale, which would hide every gap):
 *
 * - a title missing in a channel locale;
 * - a description, a localized text attribute or a media item's alt text that has a value in some
 *   locale but not in this one. One the product has in no locale at all isn't a gap.
 *
 * Channels the product lists but the catalog doesn't know are skipped. Sorted, so equal content
 * always gives equal gaps.
 */
export function contentGaps(data: ProductData, type: ProductType, channels: Channel[]): Gap[] {
  const gaps: Gap[] = [];
  const texts = type.attributes.filter(
    (a) => a.kind === 'text' && a.localized && a.scope === 'product',
  );
  const has = (l: Localized | undefined) => !!l && Object.keys(l).length > 0;
  for (const channel of channels) {
    const listing = data.channels[channel.code];
    if (!listing || listing.visible === false) continue;
    for (const locale of channel.locales) {
      const at = { locale, channel: channel.code };
      if (!data.title[locale]) gaps.push({ kind: 'missing_title', field: 'title', ...at });
      if (has(data.description) && !data.description?.[locale])
        gaps.push({ kind: 'missing_description', field: 'description', ...at });
      for (const a of texts) {
        const v = localized(data.attributes[a.code]);
        if (has(v) && !v?.[locale])
          gaps.push({
            kind: 'missing_attribute',
            field: fieldId({ field: 'attribute', code: a.code }),
            ...at,
          });
      }
      for (const m of data.media)
        if (has(m.alt) && !m.alt?.[locale])
          gaps.push({
            kind: 'missing_alt',
            field: fieldId({ field: 'mediaAlt', src: m.src }),
            ...at,
          });
    }
  }
  const order = (g: Gap) =>
    `${g.channel}\u0000${g.locale}\u0000${GAP_KINDS.indexOf(g.kind)}\u0000${g.field}`;
  return gaps.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/**
 * How the board's Gaps column groups a product, what needs a person first: the first group that
 * applies, so each product is in one.
 */
export const GAP_GROUPS = ['conflict', 'rejected', 'missing_required', 'missing'] as const;
export type GapGroup = (typeof GAP_GROUPS)[number];

export function gapGroup(kinds: Partial<Record<GapKind, number>>): GapGroup {
  if (kinds.conflict) return 'conflict';
  if (kinds.rejected) return 'rejected';
  if (kinds.missing_required) return 'missing_required';
  return 'missing';
}

/** The gaps the assistant drafts: text a product lacks in a locale. Rejections and conflicts need a person. */
export const DRAFTABLE_GAPS: readonly GapKind[] = [
  'missing_title',
  'missing_description',
  'missing_attribute',
  'missing_alt',
];

/** The most fields and locales one draft request writes. */
export const MAX_DRAFT_FIELDS = 20;

/** The longest guidance a person may add to a draft request. */
export const PRODUCT_DRAFT_INSTRUCTION_MAX = 1000;

/** Why a named field can't be drafted, or null when it can. */
export function draftRefIssue(ref: FieldRef): string | null {
  if (ref.field === 'status') return 'status is not drafted';
  if (!ref.locale) return 'needs a locale';
  if (ref.field === 'attribute' && !ref.code) return 'needs the attribute’s code';
  if (ref.field === 'mediaAlt' && !ref.src) return 'needs the image’s src';
  return null;
}

const refKey = (r: FieldRef) => `${fieldId(r)}\u0000${r.locale ?? ''}`;

/**
 * What a draft request fills, at most `MAX_DRAFT_FIELDS`, each field and locale once: the fields
 * asked for that can be drafted (`draftRefIssue`), else the product's draftable gaps that have no
 * draft or staged edit yet (`pending`), in `DRAFTABLE_GAPS` order, so titles come before alt text.
 * `more` counts the gaps left for another request.
 */
export function draftTargets(
  gaps: readonly Gap[],
  asked?: readonly FieldRef[],
  pending: readonly FieldRef[] = [],
): { targets: FieldRef[]; more: number } {
  const skip = new Set(asked?.length ? [] : pending.map(refKey));
  const refs: FieldRef[] = asked?.length
    ? asked.filter((r) => !draftRefIssue(r))
    : [...gaps]
        .filter((g) => DRAFTABLE_GAPS.includes(g.kind))
        .sort((a, b) => DRAFTABLE_GAPS.indexOf(a.kind) - DRAFTABLE_GAPS.indexOf(b.kind))
        .flatMap((g) => {
          const f = parseFieldId(g.field);
          return f ? [{ ...f, locale: g.locale }] : [];
        });
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    const k = refKey(r);
    if (seen.has(k) || skip.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    targets: unique.slice(0, MAX_DRAFT_FIELDS),
    more: asked?.length ? 0 : Math.max(0, unique.length - MAX_DRAFT_FIELDS),
  };
}

/** A field's values in every locale it has one (status has none). */
export function fieldLocales(data: ProductData, ref: Omit<FieldRef, 'locale'>): Localized {
  switch (ref.field) {
    case 'title':
      return { ...data.title };
    case 'description':
      return { ...data.description };
    case 'slug':
      return { ...data.slug };
    case 'attribute':
      return { ...localized(data.attributes[ref.code ?? '']) };
    case 'mediaAlt':
      return { ...data.media.find((m) => m.src === ref.src)?.alt };
    default:
      return {};
  }
}
