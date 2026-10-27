import type { BoardCard, BoardColumn, FieldRef, GapGroup, GapKind } from '@orderloop/core/product';

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
            c.rejection.issues[0]
              ? `${c.rejection.issues[0].path ? `${c.rejection.issues[0].path}: ` : ''}${c.rejection.issues[0].message}`
              : 'see the sheet'
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

/** A field's name on the sheet, without its locale. */
export function fieldLabel(ref: Pick<FieldRef, 'field' | 'code' | 'src'>): string {
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
      return ref.code ?? 'Attribute';
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
