import { describe, expect, it } from 'vitest';
import { productTypeSchema, typeChangeIssues } from '../src/product/model';
import { renderForChannel } from '../src/product/render';
import { productAliases, validateProduct } from '../src/product/validate';
import { apparel, stored, tee, types, web } from './fixtures/product';

describe('product types', () => {
  it('rejects types that could not be indexed or told apart', () => {
    const bad = productTypeSchema.safeParse({
      code: 't',
      version: 1,
      attributes: [
        { code: 'a', kind: 'enum' },
        { code: 'b', kind: 'number', localized: true },
        { code: 'c', kind: 'text', sortable: true },
        { code: 'c', kind: 'json', filterable: true },
      ],
      variantAxes: ['b'],
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.message)).toEqual([
      'a: enum needs values',
      'b: only text can be localized',
      'c: only numeric kinds sort',
      'duplicate attribute c',
      "c: json can't be filtered",
      'axis b must be a variant enum attribute',
    ]);
  });

  it('lets a new version only add', () => {
    const next = productTypeSchema.parse({
      ...apparel,
      version: 2,
      attributes: [
        ...apparel.attributes.map((a) =>
          a.code === 'material' ? { ...a, values: [...(a.values ?? []), { code: 'silk' }] } : a,
        ),
        { code: 'fit', kind: 'text' },
      ],
    });
    expect(typeChangeIssues(apparel, next)).toEqual([]);
    const breaking = productTypeSchema.parse({
      ...apparel,
      version: 3,
      attributes: [
        { ...apparel.attributes[0], values: [{ code: 'cotton' }] },
        { code: 'care', kind: 'number' },
        { code: 'gsm', kind: 'number', required: true },
      ],
      variantAxes: [],
    });
    expect(typeChangeIssues(apparel, breaking)).toEqual([
      'version must be 2',
      'material value wool removed',
      'material value linen removed',
      'care kind changed',
      'care localized changed',
      'tags removed (deprecate it instead)',
      'weight removed (deprecate it instead)',
      'size removed (deprecate it instead)',
      'color removed (deprecate it instead)',
      'gsm added as required',
      'variant axes changed',
    ]);
  });
});

describe('product validation', () => {
  it('accepts a product, pins the type version and defaults the primary category', () => {
    const v = validateProduct(tee(), types);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.data.type).toBe('apparel');
    expect(v.data.typeVersion).toBe(1);
    expect(v.data.primaryCategory).toBe('tops');
    expect(v.data.status).toBe('active');
  });

  it('says what is wrong with each attribute and variant', () => {
    const v = validateProduct(
      tee({
        slug: { en: 'Not A Slug' },
        attributes: {
          material: 'silk',
          weight: { value: 1, unit: 'kg' },
          colour: 'x',
          tags: 'eco',
        },
        variants: [
          { sku: 'A', attributes: { size: 'S', color: 'red' } },
          { sku: 'A', attributes: { size: 'S', color: 'red' } },
          { sku: 'B', attributes: { size: 'M' } },
        ],
        primaryCategory: 'shoes',
      }),
      types,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.issues).toEqual([
      { path: 'attributes.material', message: 'expected one of material values' },
      { path: 'attributes.weight', message: 'expected { value, unit: g }' },
      { path: 'attributes.colour', message: 'not an attribute of this type' },
      { path: 'attributes.tags', message: 'expected a list of tags values' },
      { path: 'variants.1.sku', message: 'duplicate SKU' },
      { path: 'variants.1', message: 'same options as another variant' },
      { path: 'variants.2', message: 'needs size, color' },
      { path: 'slug.en', message: 'lowercase words joined by "-"' },
      { path: 'primaryCategory', message: 'not one of categories' },
    ]);
  });

  it('rejects an unknown type and a malformed shape', () => {
    expect(validateProduct(tee({ type: 'shoes' }), types)).toMatchObject({
      ok: false,
      issues: [{ path: 'type', message: 'unknown type shoes' }],
    });
    expect(validateProduct({ key: 'has space', type: 'apparel' }, types).ok).toBe(false);
  });

  it('lists the aliases a product claims', () => {
    expect(
      productAliases({ variants: [{ sku: 'A', gtin: '12345678' } as never], slug: { en: 'a' } }),
    ).toEqual(['sku:A', 'gtin:12345678', 'slug:en:a']);
  });
});

describe('publishing', () => {
  it('renders a doc per locale with labels resolved and the channel price picked', () => {
    const { rendered, index } = renderForChannel(stored(tee()), apparel, web, {
      uid: 7,
      createdAt: 1,
    });
    expect(rendered?.map((r) => r.locale)).toEqual(['en', 'fr']);
    const fr = JSON.parse(rendered?.[1]?.doc ?? '{}');
    expect(fr.title).toBe('T-shirt classique');
    expect(fr.attributes.material).toEqual({ code: 'cotton', label: 'Coton' });
    // A missing translation falls back to the channel's default locale.
    expect(fr.attributes.care).toBe('Wash cold');
    expect(fr.variants[0].options).toEqual({
      size: { code: 'S', label: 'S' },
      color: { code: 'red', label: 'Red' },
    });
    expect(fr.price).toEqual({ amount: 1999, currency: 'USD' });
    expect(fr.priceRange).toEqual({
      min: { amount: 1999, currency: 'USD' },
      max: { amount: 2200, currency: 'USD' },
    });
    const card = JSON.parse(rendered?.[0]?.card ?? '{}');
    expect(card).toMatchObject({
      key: 'tee-classic',
      title: 'Classic tee',
      variants: 2,
      attributes: { material: { code: 'cotton', label: 'Cotton' } },
    });
    expect(rendered?.[0]?.search).toMatchObject({
      title: 'Classic tee',
      brand: 'Acme',
      skus: 'TEE-S-RED  TEE-M-RED ',
    });
    expect(index).toEqual({
      key: 'tee-classic',
      uid: 7,
      version: 1,
      categories: ['tops', 'tees'],
      terms: {
        brand: ['Acme'],
        material: ['cotton'],
        tags: ['eco'],
        size: ['S', 'M'],
        color: ['red'],
      },
      numbers: { price: [1999, 2200], weight: [180] },
      createdAt: 1,
    });
  });

  it('publishes nothing for a product that is not active and listed in the channel', () => {
    expect(
      renderForChannel(stored(tee({ status: 'draft' })), apparel, web, { uid: 7, createdAt: 1 })
        .rendered,
    ).toBeNull();
    expect(
      renderForChannel(stored(tee({ channels: {} })), apparel, web, { uid: 7, createdAt: 1 })
        .rendered,
    ).toBeNull();
    expect(
      renderForChannel(stored(tee({ channels: { web: { visible: false } } })), apparel, web, {
        uid: 7,
        createdAt: 1,
      }).index,
    ).toBeNull();
  });
});
