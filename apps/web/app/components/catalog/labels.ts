import type {
  BoardCard,
  BoardColumn,
  FieldRef,
  GapGroup,
  GapKind,
  Rejection,
} from '@orderloop/core/product';
import { humanize } from '~/lib/format';

/** The board's columns, left to right toward live. */
export const COLUMN_LABEL: Record<BoardColumn, string> = {
  gaps: 'Gaps',
  drafted: 'Drafted',
  staged: 'Staged',
  published: 'Published today',
};

/** A Gaps group's heading, and how a card says it has that kind of gap. */
export const GAP_LABEL: Record<GapKind, { group: string; short: string }> = {
  conflict: { group: 'Conflicts', short: 'feed changed an edited field' },
  rejected: { group: 'Rejected rows', short: 'feed row refused' },
  missing_required: { group: 'Missing required', short: 'required attribute missing' },
  missing_title: { group: 'Missing titles', short: 'title' },
  missing_description: { group: 'Missing descriptions', short: 'description' },
  missing_attribute: { group: 'Missing attribute text', short: 'attribute\u00a0text' },
  missing_alt: { group: 'Missing alt text', short: 'alt\u00a0text' },
};

/** Gaps the assistant can draft: text a product lacks in a locale. The rest need a person. */
export const DRAFTABLE: ReadonlySet<GapKind> = new Set([
  'missing_title',
  'missing_description',
  'missing_attribute',
  'missing_alt',
]);

export const draftable = (c: Pick<BoardCard, 'kinds'>) =>
  Object.entries(c.kinds).some(([k, n]) => n && DRAFTABLE.has(k as GapKind));

// A non-breaking space, so "×6" never wraps away from what it counts.
const times = (n: number | undefined) => (n && n > 1 ? `\u00a0×${n}` : '');

/** The text a card lacks, by kind: "title ×2, alt text"; empty when it lacks none. */
export function missingText(c: Pick<BoardCard, 'kinds'>): string {
  return (['missing_title', 'missing_description', 'missing_attribute', 'missing_alt'] as const)
    .filter((k) => c.kinds[k])
    .map((k) => `${GAP_LABEL[k].short}${times(c.kinds[k])}`)
    .join(', ');
}

/** What put a card where it is, in one line: "Missing title ×2, alt text". */
export function cardReason(c: BoardCard): string {
  switch (c.column) {
    case 'gaps': {
      const parts: string[] = [];
      if (c.kinds.conflict) parts.push(`Feed changed an edited field${times(c.kinds.conflict)}`);
      if (c.rejection)
        parts.push(
          `${c.rejection.row !== undefined ? `Row ${c.rejection.row} refused` : 'Refused'}: ${
            c.rejection.issues[0] ? issueText(c.rejection.issues[0]) : 'see the sheet'
          }`,
        );
      else if (c.kinds.rejected) parts.push('Feed row refused');
      const missing = missingText(c);
      if (missing) parts.push(`Missing ${missing}`);
      if (c.kinds.missing_required) parts.push('Required attribute missing');
      return parts.join(' · ') || 'Needs a look';
    }
    case 'drafted':
      return `${c.drafts} ${c.drafts === 1 ? 'draft' : 'drafts'} to review`;
    case 'staged':
      return c.failure
        ? `Didn’t publish: ${c.failure}`
        : `${c.staged} ${c.staged === 1 ? 'edit' : 'edits'} waiting to publish`;
    case 'published':
      return 'Published';
  }
}

/**
 * A field's name on the sheet, without its locale. An attribute reads by the label its product
 * type gives it (`labels`, by code), else its code in words: "care" → "Care".
 */
export function fieldLabel(
  ref: Pick<FieldRef, 'field' | 'code' | 'src'>,
  labels: Record<string, string> = {},
): string {
  switch (ref.field) {
    case 'title':
      return 'Title';
    case 'description':
      return 'Description';
    case 'slug':
      return 'Slug';
    case 'status':
      return 'Status';
    case 'attribute':
      return ref.code ? (labels[ref.code] ?? words(ref.code)) : 'Attribute';
    case 'mediaAlt':
      return 'Alt text';
  }
}

/** The same field and locale. */
export const sameRef = (a: FieldRef, b: FieldRef) =>
  a.field === b.field &&
  (a.code ?? '') === (b.code ?? '') &&
  (a.src ?? '') === (b.src ?? '') &&
  (a.locale ?? '') === (b.locale ?? '');

/** A Gaps group's heading (`gapGroup` decides which group a product is in). */
export const GROUP_LABEL: Record<GapGroup, string> = {
  conflict: 'Conflicts',
  rejected: 'Rejected rows',
  missing_required: 'Missing required',
  missing: 'Missing text',
};

/** The gap kind a group lists, when it is one kind; Missing text reads the whole column. */
export const GROUP_KIND: Partial<Record<GapGroup, GapKind>> = {
  conflict: 'conflict',
  rejected: 'rejected',
  missing_required: 'missing_required',
};

type Issue = Rejection['issues'][number];

const ACRONYMS: Record<string, string> = { sku: 'SKU', gtin: 'GTIN', url: 'URL', id: 'ID' };

/** A code in words, keeping the acronyms people say as letters: "sku" → "SKU", "care_info" → "Care info". */
const words = (code: string) =>
  humanize(code)
    .split(' ')
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w)
    .join(' ');

const singular = (s: string) =>
  s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('s') ? s.slice(0, -1) : s;

/**
 * Where an issue is, from its dotted path: "variants.0.sku" → "Variant 1 SKU",
 * "attributes.care" → "Care", "title.en" → "Title (en)".
 */
function where(path: string): string {
  const parts = path.split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const next = parts[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) {
      out.push(`${singular(p)} ${Number(next) + 1}`);
      i++;
    } else if (p === 'attributes' && next) {
      out.push(words(next));
      i++;
    } else if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(p) && i > 0) out.push(`(${p})`);
    else out.push(words(p).toLowerCase());
  }
  const text = out.join(' ').replace(/\b(sku|gtin|url|id)\b/g, (w) => ACRONYMS[w]!);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A feed row's validation issue as a sentence: "variants" with zod's "Too small: expected array to
 * have >=1 items" reads "Needs at least one variant". One we don't know keeps its message after
 * where it is, without the validator's "Invalid input:" preamble.
 */
export function issueText({ path, message }: Issue): string {
  const at = where(path);
  const last =
    path
      .split('.')
      .filter((p) => p && !/^\d+$/.test(p))
      .at(-1) ?? '';
  const item = words(singular(last)).toLowerCase() || 'item';
  const min = /^Too small: expected array to have >=(\d+) items?$/.exec(message);
  if (min) {
    const n = Number(min[1]);
    return n === 1 ? `Needs at least one ${item}` : `Needs at least ${n} ${item}s`;
  }
  if (/^Too small: expected string to have >=1 characters?$/.test(message))
    return `${at || 'A value'} is empty`;
  const long = /^Too big: expected string to have <=(\d+) characters?$/.exec(message);
  if (long) return `${at || 'A value'} is longer than ${long[1]} characters`;
  const many = /^Too big: expected array to have <=(\d+) items?$/.exec(message);
  if (many) return `Too many ${item}s (at most ${many[1]})`;
  if (message === 'required' || /^Invalid input: expected \w+, received undefined$/.test(message))
    return `${at || 'A value'} is missing`;
  const type = /^Invalid input: expected (\w+), received \w+$/.exec(message);
  if (type)
    return `${at || 'A value'} should be ${/^[aeiou]/.test(type[1]!) ? 'an' : 'a'} ${type[1]}`;
  if (/^Invalid option: expected one of /.test(message))
    return `${at || 'A value'} isn’t one of the allowed values`;
  const text = message.replace(/^Invalid (input|string|option): /, '');
  if (!at) return text.charAt(0).toUpperCase() + text.slice(1);
  return `${at}: ${text}`;
}
