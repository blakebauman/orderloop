import type { Channel, Product, ProductInput, ProductType } from '../../src/product/model';
import { productTypeSchema } from '../../src/product/model';
import { contentHash } from '../../src/product/routing';
import { validateProduct } from '../../src/product/validate';

export const apparel: ProductType = productTypeSchema.parse({
  code: 'apparel',
  version: 1,
  attributes: [
    {
      code: 'material',
      kind: 'enum',
      filterable: true,
      card: true,
      values: [
        { code: 'cotton', label: { en: 'Cotton', fr: 'Coton' } },
        { code: 'wool' },
        { code: 'linen' },
      ],
    },
    { code: 'care', kind: 'text', localized: true, searchable: true },
    {
      code: 'tags',
      kind: 'multi_enum',
      filterable: true,
      values: [{ code: 'eco' }, { code: 'sale' }, { code: 'new' }],
    },
    {
      code: 'weight',
      kind: 'measure',
      unit: 'g',
      filterable: true,
      sortable: true,
      buckets: [200, 500],
    },
    {
      code: 'size',
      kind: 'enum',
      scope: 'variant',
      filterable: true,
      values: [{ code: 'S' }, { code: 'M' }, { code: 'L' }],
    },
    {
      code: 'color',
      kind: 'enum',
      scope: 'variant',
      filterable: true,
      values: [{ code: 'red', label: { en: 'Red' } }, { code: 'blue' }],
    },
  ],
  variantAxes: ['size', 'color'],
});

export const types = (code: string, version?: number) =>
  code === apparel.code && (version === undefined || version === apparel.version)
    ? apparel
    : undefined;

export const web: Channel = {
  code: 'web',
  name: 'Web store',
  currency: 'USD',
  locales: ['en', 'fr'],
  defaultLocale: 'en',
};

export function tee(over: Partial<ProductInput> = {}): ProductInput {
  return {
    key: 'tee-classic',
    type: 'apparel',
    title: { en: 'Classic tee', fr: 'T-shirt classique' },
    slug: { en: 'classic-tee' },
    brand: 'Acme',
    categories: ['tops', 'tees'],
    media: [{ src: 'media/tee.jpg', alt: { en: 'A tee' }, width: 800, height: 800 }],
    attributes: {
      material: 'cotton',
      care: { en: 'Wash cold' },
      tags: ['eco'],
      weight: { value: 180, unit: 'g' },
    },
    variants: [
      { sku: 'TEE-S-RED', attributes: { size: 'S', color: 'red' } },
      {
        sku: 'TEE-M-RED',
        attributes: { size: 'M', color: 'red' },
        prices: { web: { amount: 2200, currency: 'USD' } },
      },
    ],
    channels: { web: { visible: true, price: { amount: 1999, currency: 'USD' } } },
    ...over,
  };
}

/** A stored product built from input, as the shard would hold it. */
export function stored(input: ProductInput, version = 1, updatedAt = 1_700_000_000_000): Product {
  const v = validateProduct(input, types);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return { ...v.data, version, hash: contentHash(v.data), updatedAt };
}
