import type { BoardCard, BoardColumn, DraftInput } from '@orderloop/core/product';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, by, product, setup } from './helpers';

beforeAll(setup);

const ed = 'editor@orderloop';
const titleFr = { field: 'title' as const, locale: 'fr' };
const descFr = { field: 'description' as const, locale: 'fr' };

async function card(column: BoardColumn, key: string): Promise<BoardCard | undefined> {
  let cursor: string | undefined;
  do {
    const page = await api.listBoard({ column, cursor, limit: 100 });
    const found = page.items.find((c) => c.key === key);
    if (found) return found;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return undefined;
}

const draft = (key: string, ref: DraftInput['ref'], value: string): DraftInput => ({
  key,
  ref,
  value,
  model: 'test-model',
});

describe('assistant drafts', () => {
  it('stores a draft without touching the product, and puts it on Drafted', async () => {
    const p = product();
    await api.putProducts([p], { by });
    expect(await api.putDrafts([draft(p.key, titleFr, 'Le t-shirt')], ed)).toEqual([
      { key: p.key, ref: titleFr, ok: true },
    ]);
    expect((await api.getProduct(p.key))?.title.fr).toBe(p.title.fr);
    expect(await card('drafted', p.key)).toMatchObject({ drafts: 1, staged: 0 });
    expect((await api.getProductSheet(p.key))?.drafts).toEqual([
      expect.objectContaining({
        ref: titleFr,
        value: 'Le t-shirt',
        seen: p.title.fr,
        stale: false,
        model: 'test-model',
        by: ed,
      }),
    ]);
    expect((await api.catalogBoard()).columns.drafted).toBeGreaterThan(0);
  });

  it('moves a product with gaps to Drafted, where its card still counts the gaps', async () => {
    const p = product({ description: { en: 'A cotton tee.' } });
    await api.putProducts([p], { by });
    expect(await card('gaps', p.key)).toBeDefined();
    await api.putDrafts([draft(p.key, descFr, 'Un t-shirt en coton.')], ed);
    expect(await card('drafted', p.key)).toMatchObject({
      drafts: 1,
      kinds: { missing_description: 1 },
    });
    expect(await card('gaps', p.key)).toBeUndefined();
    // Dropping the draft puts it back where its gaps are.
    await api.discardDrafts([{ key: p.key }], ed);
    expect(await card('gaps', p.key)).toMatchObject({ drafts: 0 });
  });

  it('is accepted by staging it as the assistant, and publishes as an assistant edit', async () => {
    const p = product({ description: { en: 'A cotton tee.' } });
    await api.putProducts([p], { by });
    await api.putDrafts([draft(p.key, descFr, 'Un t-shirt.')], ed);
    await api.stageEdits(
      [{ key: p.key, ref: descFr, op: 'set', value: 'Un t-shirt.', source: 'assistant' }],
      ed,
    );
    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.drafts).toEqual([]);
    expect(sheet?.staged[0]).toMatchObject({ source: 'assistant', value: 'Un t-shirt.' });
    const [r] = await api.publishStaged([p.key], { by: ed, requestId: `drafts-${p.key}` });
    expect(r?.status).toBe('published');
    const after = await api.getProductSheet(p.key);
    expect(after?.overrides[0]).toMatchObject({ source: 'assistant', value: 'Un t-shirt.' });
    expect(after?.revisions[0]?.source).toBe('assistant');
  });

  it('is consumed when a person stages their own text for the field', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await api.putDrafts([draft(p.key, titleFr, 'Brouillon'), draft(p.key, descFr, 'Texte')], ed);
    await api.stageEdits([{ key: p.key, ref: titleFr, op: 'set', value: 'Le mien' }], ed);
    const sheet = await api.getProductSheet(p.key);
    expect(sheet?.drafts.map((d) => d.ref.field)).toEqual(['description']);
    expect(await card('staged', p.key)).toMatchObject({ drafts: 1, staged: 1 });
  });

  it('turns stale once the field changes, and replaces an earlier draft', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await api.putDrafts([draft(p.key, titleFr, 'Premier')], ed);
    await api.putDrafts([draft(p.key, titleFr, 'Second')], ed);
    await api.putProducts([{ ...p, title: { en: p.title.en ?? '', fr: 'Nouveau' } }], { by });
    expect((await api.getProductSheet(p.key))?.drafts).toEqual([
      expect.objectContaining({ value: 'Second', seen: p.title.fr, stale: true }),
    ]);
  });

  it('refuses what an edit would refuse, and status, per draft', async () => {
    const p = product();
    await api.putProducts([p], { by });
    const r = await api.putDrafts(
      [
        draft('no-such-product', titleFr, 'x'),
        draft(p.key, { field: 'status' }, 'draft'),
        draft(p.key, { field: 'slug', locale: 'fr' }, 'Pas Un Slug'),
        draft(p.key, { field: 'price' as 'title', locale: 'fr' }, '9'),
        { key: p.key, ref: titleFr, value: null as unknown as string },
      ],
      ed,
    );
    expect(r.map((x) => (x.ok ? 'ok' : x.issues[0]))).toEqual([
      'no such product',
      'status is not drafted',
      'lowercase words joined by "-"',
      'not an editable field',
      'a draft is text',
    ]);
    expect((await api.getProductSheet(p.key))?.drafts).toEqual([]);
  });

  it('discards one draft or all, and forgets them when the product is deleted', async () => {
    const p = product();
    await api.putProducts([p], { by });
    await api.putDrafts([draft(p.key, titleFr, 'A'), draft(p.key, descFr, 'B')], ed);
    expect(await api.discardDrafts([{ key: p.key, ref: titleFr }], ed)).toEqual({ discarded: 1 });
    expect(await card('drafted', p.key)).toMatchObject({ drafts: 1 });
    expect(await api.discardDrafts([{ key: p.key }], ed)).toEqual({ discarded: 1 });
    expect(await card('drafted', p.key)).toBeUndefined();

    await api.putDrafts([draft(p.key, titleFr, 'C')], ed);
    await api.deleteProducts([p.key], { by });
    await api.putProducts([p], { by });
    expect((await api.getProductSheet(p.key))?.drafts).toEqual([]);
  });
});
