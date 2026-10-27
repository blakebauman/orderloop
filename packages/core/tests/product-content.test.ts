import { describe, expect, it } from 'vitest';
import type { Gap, GapKind } from '../src/product/content';
import {
  applyOverrides,
  contentGaps,
  draftRefIssue,
  draftTargets,
  editIssues,
  fieldId,
  fieldLocales,
  fieldValue,
  gapGroup,
  MAX_DRAFT_FIELDS,
  overrideConflict,
  parseFieldId,
} from '../src/product/content';
import type { Channel } from '../src/product/model';
import { contentHash } from '../src/product/routing';
import { apparel, stored, tee, web } from './fixtures/product';

const feed = stored(tee());

describe('field ids', () => {
  it('round-trips every editable field', () => {
    for (const ref of [
      { field: 'title' },
      { field: 'description' },
      { field: 'slug' },
      { field: 'status' },
      { field: 'attribute', code: 'care' },
      { field: 'mediaAlt', src: 'media/tee.jpg' },
    ] as const)
      expect(parseFieldId(fieldId(ref))).toEqual(ref);
    expect(fieldId({ field: 'mediaAlt', src: 'https://x/a:b.jpg' })).toBe('alt:https://x/a:b.jpg');
    expect(parseFieldId('alt:https://x/a:b.jpg')).toEqual({
      field: 'mediaAlt',
      src: 'https://x/a:b.jpg',
    });
  });

  it('names nothing for unknown or empty ids', () => {
    for (const id of ['', 'price', 'attribute', 'mediaAlt', 'attr:', 'alt:'])
      expect(parseFieldId(id)).toBeNull();
  });
});

describe('field values', () => {
  it('reads one locale of each field', () => {
    expect(fieldValue(feed, { field: 'title', locale: 'fr' })).toBe('T-shirt classique');
    expect(fieldValue(feed, { field: 'slug', locale: 'en' })).toBe('classic-tee');
    expect(fieldValue(feed, { field: 'description', locale: 'en' })).toBeNull();
    expect(fieldValue(feed, { field: 'attribute', code: 'care', locale: 'en' })).toBe('Wash cold');
    expect(fieldValue(feed, { field: 'attribute', code: 'material', locale: 'en' })).toBeNull();
    expect(fieldValue(feed, { field: 'mediaAlt', src: 'media/tee.jpg', locale: 'en' })).toBe(
      'A tee',
    );
    expect(fieldValue(feed, { field: 'mediaAlt', src: 'gone.jpg', locale: 'en' })).toBeNull();
    expect(fieldValue(feed, { field: 'status' })).toBe('active');
  });
});

describe('overrides', () => {
  it('sets and removes values per locale over the feed, leaving the feed untouched', () => {
    const before = contentHash(feed);
    const out = applyOverrides(feed, [
      { ref: { field: 'description', locale: 'fr' }, value: 'Un t-shirt en coton.' },
      { ref: { field: 'title', locale: 'fr' }, value: null },
      { ref: { field: 'slug', locale: 'fr' }, value: 'tee-classique' },
      { ref: { field: 'attribute', code: 'care', locale: 'fr' }, value: 'Lavage à froid' },
      { ref: { field: 'mediaAlt', src: 'media/tee.jpg', locale: 'fr' }, value: 'Un t-shirt' },
      { ref: { field: 'status' }, value: 'draft' },
    ]);
    expect(out.description).toEqual({ fr: 'Un t-shirt en coton.' });
    expect(out.title).toEqual({ en: 'Classic tee' });
    expect(out.slug).toEqual({ en: 'classic-tee', fr: 'tee-classique' });
    expect(out.attributes.care).toEqual({ en: 'Wash cold', fr: 'Lavage à froid' });
    expect(out.attributes.material).toBe('cotton');
    expect(out.media[0]?.alt).toEqual({ en: 'A tee', fr: 'Un t-shirt' });
    expect(out.status).toBe('draft');
    expect(contentHash(feed)).toBe(before);
  });

  it('drops a field once its last locale is removed', () => {
    const out = applyOverrides(feed, [
      { ref: { field: 'slug', locale: 'en' }, value: null },
      { ref: { field: 'attribute', code: 'care', locale: 'en' }, value: null },
      { ref: { field: 'mediaAlt', src: 'media/tee.jpg', locale: 'en' }, value: null },
    ]);
    expect(out.slug).toBeUndefined();
    expect('care' in out.attributes).toBe(false);
    expect(out.media[0] && 'alt' in out.media[0]).toBe(false);
  });

  it('skips an override whose media the feed no longer has', () => {
    const out = applyOverrides(feed, [
      { ref: { field: 'mediaAlt', src: 'old.jpg', locale: 'en' }, value: 'Old' },
    ]);
    expect(out.media).toEqual(feed.media);
  });

  it('never removes the last title, whatever the feed has dropped since', () => {
    const one = stored(tee({ title: { fr: 'T-shirt classique' } }));
    const out = applyOverrides(one, [{ ref: { field: 'title', locale: 'fr' }, value: null }]);
    expect(out.title).toEqual({ fr: 'T-shirt classique' });
  });

  it('returns the feed as it is when there are no overrides', () => {
    expect(applyOverrides(feed, [])).toBe(feed);
  });

  it('gives the same product, and hash, whichever order the overrides come in', () => {
    const edits = [
      { ref: { field: 'description' as const, locale: 'fr' }, value: 'Coton.' },
      { ref: { field: 'title' as const, locale: 'fr' }, value: 'T-shirt' },
    ];
    expect(contentHash(applyOverrides(feed, edits))).toBe(
      contentHash(applyOverrides(feed, [...edits].reverse())),
    );
  });
});

describe('override conflicts', () => {
  const desc = { field: 'description' as const, locale: 'fr' };

  it('holds while the feed keeps the value the override was made against', () => {
    expect(overrideConflict(feed, { ref: desc, value: 'Coton.', base: null })).toBe(false);
    expect(
      overrideConflict(feed, {
        ref: { field: 'title', locale: 'fr' },
        value: 'T-shirt',
        base: 'T-shirt classique',
      }),
    ).toBe(false);
  });

  it('conflicts once the feed changes, adds or drops that value', () => {
    const changed = stored(tee({ description: { fr: 'Du coton.' } }));
    expect(overrideConflict(changed, { ref: desc, value: 'Coton.', base: null })).toBe(true);
    const title = { field: 'title' as const, locale: 'fr' };
    expect(overrideConflict(feed, { ref: title, value: 'T-shirt', base: 'Vieux titre' })).toBe(
      true,
    );
  });

  it('conflicts when the media it names is gone, even with no alt before', () => {
    const ref = { field: 'mediaAlt' as const, src: 'old.jpg', locale: 'fr' };
    expect(overrideConflict(feed, { ref, value: 'Ancien', base: null })).toBe(true);
  });
});

describe('edit checks', () => {
  const issues = (ref: Parameters<typeof fieldId>[0], value: string | null) =>
    editIssues(feed, apparel, { ref, value });

  it('accepts content edits', () => {
    expect(issues({ field: 'description', locale: 'fr' }, 'Coton.')).toEqual([]);
    expect(issues({ field: 'attribute', code: 'care', locale: 'fr' }, 'Froid')).toEqual([]);
    expect(issues({ field: 'mediaAlt', src: 'media/tee.jpg', locale: 'fr' }, 'Un t-shirt')).toEqual(
      [],
    );
    expect(issues({ field: 'slug', locale: 'fr' }, 'tee-classique')).toEqual([]);
    expect(issues({ field: 'title', locale: 'fr' }, null)).toEqual([]);
    expect(issues({ field: 'status' }, 'archived')).toEqual([]);
  });

  it('refuses what the catalog would not store', () => {
    expect(issues({ field: 'description' }, 'x')).toEqual(['needs a locale']);
    expect(issues({ field: 'description', locale: 'FR' }, 'x')).toEqual(['needs a locale']);
    expect(issues({ field: 'description', locale: 'fr' }, 'x'.repeat(10_001))).toEqual([
      'over 10000 characters',
    ]);
    expect(issues({ field: 'description', locale: 'fr' }, '  ')).toEqual([
      'empty: remove the value instead',
    ]);
    expect(issues({ field: 'slug', locale: 'fr' }, 'Tee Classique')).toEqual([
      'lowercase words joined by "-"',
    ]);
    expect(issues({ field: 'status' }, 'live')).toEqual([
      'status must be one of draft, active, archived',
    ]);
    expect(issues({ field: 'mediaAlt', src: 'gone.jpg', locale: 'en' }, 'x')).toEqual([
      'no such media',
    ]);
  });

  it('edits only product text with a value per locale', () => {
    expect(issues({ field: 'attribute', code: 'material', locale: 'en' }, 'x')).toEqual([
      "material isn't product text with a value per locale",
    ]);
    expect(issues({ field: 'attribute', code: 'size', locale: 'en' }, 'x')).toEqual([
      "size isn't product text with a value per locale",
    ]);
    expect(issues({ field: 'attribute', code: 'fit', locale: 'en' }, 'x')).toEqual([
      'no attribute fit in apparel@1',
    ]);
  });

  it('keeps a required attribute in at least one locale', () => {
    const strict = {
      ...apparel,
      attributes: apparel.attributes.map((a) => (a.code === 'care' ? { ...a, required: true } : a)),
    };
    const care = { field: 'attribute' as const, code: 'care', locale: 'en' };
    expect(editIssues(feed, strict, { ref: care, value: null })).toEqual([
      'care is required in at least one locale',
    ]);
    expect(editIssues(feed, apparel, { ref: care, value: null })).toEqual([]);
  });

  it('keeps a title in at least one locale', () => {
    const one = stored(tee({ title: { en: 'Classic tee' } }));
    expect(
      editIssues(one, apparel, { ref: { field: 'title', locale: 'en' }, value: null }),
    ).toEqual(['a product needs a title in at least one locale']);
  });
});

describe('content gaps', () => {
  const pos: Channel = {
    code: 'pos',
    name: 'Stores',
    currency: 'USD',
    locales: ['en', 'de'],
    defaultLocale: 'en',
  };

  it('finds what is missing in each locale of each channel the product is visible in', () => {
    const p = stored(
      tee({
        description: { en: 'A cotton tee.' },
        channels: {
          web: { visible: true },
          pos: { visible: true },
        },
      }),
    );
    expect(contentGaps(p, apparel, [web, pos])).toEqual([
      { kind: 'missing_title', field: 'title', locale: 'de', channel: 'pos' },
      { kind: 'missing_description', field: 'description', locale: 'de', channel: 'pos' },
      { kind: 'missing_attribute', field: 'attr:care', locale: 'de', channel: 'pos' },
      { kind: 'missing_alt', field: 'alt:media/tee.jpg', locale: 'de', channel: 'pos' },
      { kind: 'missing_description', field: 'description', locale: 'fr', channel: 'web' },
      { kind: 'missing_attribute', field: 'attr:care', locale: 'fr', channel: 'web' },
      { kind: 'missing_alt', field: 'alt:media/tee.jpg', locale: 'fr', channel: 'web' },
    ]);
  });

  it('counts by exact locale, not the fallback publishing would use', () => {
    const p = stored(tee({ title: { en: 'Classic tee' } }));
    expect(contentGaps(p, apparel, [web]).filter((g) => g.kind === 'missing_title')).toEqual([
      { kind: 'missing_title', field: 'title', locale: 'fr', channel: 'web' },
    ]);
  });

  it("doesn't count content the product has in no locale", () => {
    const p = stored(
      tee({
        title: { en: 'Classic tee', fr: 'T-shirt classique' },
        media: [{ src: 'media/tee.jpg' }],
        attributes: { material: 'cotton' },
      }),
    );
    expect(contentGaps(p, apparel, [web])).toEqual([]);
  });

  it('skips channels the product is hidden in or the catalog does not have', () => {
    const p = stored(tee({ channels: { web: { visible: false }, pos: { visible: true } } }));
    expect(contentGaps(p, apparel, [web])).toEqual([]);
  });

  it('closes a gap once an override fills it', () => {
    const p = applyOverrides(stored(tee()), [
      { ref: { field: 'attribute', code: 'care', locale: 'fr' }, value: 'Lavage à froid' },
      { ref: { field: 'mediaAlt', src: 'media/tee.jpg', locale: 'fr' }, value: 'Un t-shirt' },
    ]);
    expect(contentGaps(p, apparel, [web])).toEqual([]);
  });
});

describe('draft targets', () => {
  const gap = (kind: GapKind, field: string, locale = 'fr', channel = 'web'): Gap => ({
    kind,
    field,
    locale,
    channel,
  });

  it("are a product's text gaps, once each, titles first, without what needs a person", () => {
    expect(
      draftTargets([
        gap('missing_alt', 'alt:media/tee.jpg'),
        gap('missing_attribute', 'attr:care', 'de'),
        gap('missing_title', 'title'),
        gap('missing_title', 'title', 'fr', 'pos'),
        gap('conflict', 'description'),
        gap('rejected', 'title', 'en'),
        gap('missing_required', 'attr:size', 'en'),
      ]),
    ).toEqual({
      targets: [
        { field: 'title', locale: 'fr' },
        { field: 'attribute', code: 'care', locale: 'de' },
        { field: 'mediaAlt', src: 'media/tee.jpg', locale: 'fr' },
      ],
      more: 0,
    });
  });

  it('skip gaps with a draft or staged edit waiting, and count what is left past the limit', () => {
    const gaps = Array.from({ length: 25 }, (_, i) => gap('missing_alt', `alt:m${i}.jpg`));
    const { targets, more } = draftTargets(
      [...gaps, gap('missing_title', 'title'), gap('missing_description', 'description')],
      undefined,
      [{ field: 'title', locale: 'fr' }],
    );
    expect(targets[0]).toEqual({ field: 'description', locale: 'fr' });
    expect(targets).toHaveLength(MAX_DRAFT_FIELDS);
    expect(more).toBe(6);
  });

  it('are the fields asked for instead, even with a draft waiting, if they can be drafted', () => {
    expect(
      draftTargets(
        [gap('missing_title', 'title')],
        [
          { field: 'slug', locale: 'fr' },
          { field: 'slug', locale: 'fr' },
          { field: 'status' },
          { field: 'description' },
          { field: 'attribute', locale: 'fr' },
        ],
        [{ field: 'slug', locale: 'fr' }],
      ),
    ).toEqual({ targets: [{ field: 'slug', locale: 'fr' }], more: 0 });
    expect(
      [
        { field: 'status' as const },
        { field: 'title' as const },
        { field: 'attribute' as const, locale: 'fr' },
        { field: 'mediaAlt' as const, locale: 'fr' },
        { field: 'title' as const, locale: 'fr' },
      ].map(draftRefIssue),
    ).toEqual([
      'status is not drafted',
      'needs a locale',
      'needs the attribute’s code',
      'needs the image’s src',
      null,
    ]);
  });

  it(`stop at ${MAX_DRAFT_FIELDS}`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      field: 'title' as const,
      locale: `l${i}`,
    }));
    expect(draftTargets([], many).targets).toHaveLength(MAX_DRAFT_FIELDS);
  });

  it("read a field's text in every locale it has", () => {
    expect(fieldLocales(feed, { field: 'attribute', code: 'care' })).toEqual(feed.attributes.care);
    expect(fieldLocales(feed, { field: 'mediaAlt', src: 'nope' })).toEqual({});
    expect(fieldLocales(feed, { field: 'status' })).toEqual({});
  });
});

describe('gap groups', () => {
  it('put a product in the first group that applies, what needs a person first', () => {
    expect(gapGroup({ conflict: 1, rejected: 1, missing_title: 2 })).toBe('conflict');
    expect(gapGroup({ rejected: 1, missing_required: 1 })).toBe('rejected');
    expect(gapGroup({ missing_required: 1, missing_alt: 1 })).toBe('missing_required');
    expect(gapGroup({ missing_alt: 1 })).toBe('missing');
    expect(gapGroup({})).toBe('missing');
  });
});
