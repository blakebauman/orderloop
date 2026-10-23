/**
 * Product validation. Each product type version compiles once into plain checker functions (types
 * are immutable per version, so the compiled form is cached for the isolate's life); validating a
 * feed row is then a zod parse of the fixed shape plus a loop over its attributes. Pure.
 */
import {
  type AttributeDef,
  LIMITS,
  type Localized,
  type ProductData,
  type ProductInput,
  type ProductType,
  parseTypeRef,
  productInputSchema,
} from './model';

export type Issue = { path: string; message: string };
export type Validated = { ok: true; data: ProductData } | { ok: false; issues: Issue[] };

type Check = (value: unknown) => string | undefined;

export type CompiledType = {
  type: ProductType;
  product: Map<string, { def: AttributeDef; check: Check }>;
  variant: Map<string, { def: AttributeDef; check: Check }>;
  requiredProduct: string[];
  requiredVariant: string[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG = /^[\p{Ll}\p{Lo}\p{N}]+(-[\p{Ll}\p{Lo}\p{N}]+)*$/u;

function checker(def: AttributeDef): Check {
  switch (def.kind) {
    case 'text':
      if (def.localized)
        return (v) =>
          isRecord(v) && Object.values(v).every((s) => typeof s === 'string' && s.length <= 10_000)
            ? undefined
            : 'expected text per locale';
      return (v) => (typeof v === 'string' && v.length <= 10_000 ? undefined : 'expected text');
    case 'number':
      return (v) => (typeof v === 'number' && Number.isFinite(v) ? undefined : 'expected a number');
    case 'bool':
      return (v) => (typeof v === 'boolean' ? undefined : 'expected true or false');
    case 'enum': {
      const allowed = new Set(def.values?.map((x) => x.code));
      return (v) =>
        typeof v === 'string' && allowed.has(v) ? undefined : `expected one of ${def.code} values`;
    }
    case 'multi_enum': {
      const allowed = new Set(def.values?.map((x) => x.code));
      return (v) =>
        Array.isArray(v) &&
        v.length <= 100 &&
        v.every((x) => typeof x === 'string' && allowed.has(x))
          ? undefined
          : `expected a list of ${def.code} values`;
    }
    case 'money':
      return (v) =>
        isRecord(v) &&
        Number.isSafeInteger(v.amount) &&
        typeof v.currency === 'string' &&
        /^[A-Z]{3}$/.test(v.currency)
          ? undefined
          : 'expected { amount: minor units, currency }';
    case 'measure':
      return (v) =>
        isRecord(v) &&
        typeof v.value === 'number' &&
        Number.isFinite(v.value) &&
        (def.unit === undefined || v.unit === def.unit)
          ? undefined
          : `expected { value, unit: ${def.unit ?? 'string'} }`;
    case 'date':
      return (v) =>
        typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))
          ? undefined
          : 'expected an ISO date';
    case 'ref':
      return (v) => (typeof v === 'string' && REF.test(v) ? undefined : 'expected a product key');
    case 'json':
      return (v) => {
        try {
          return JSON.stringify(v).length <= 16_384 ? undefined : 'json value over 16 KB';
        } catch {
          return 'not serializable';
        }
      };
  }
}

const compiled = new Map<string, CompiledType>();

/** The compiled form of a type version, built on first use. */
export function compileType(type: ProductType): CompiledType {
  const id = `${type.code}@${type.version}`;
  const hit = compiled.get(id);
  if (hit) return hit;
  const c: CompiledType = {
    type,
    product: new Map(),
    variant: new Map(),
    requiredProduct: [],
    requiredVariant: [],
  };
  for (const def of type.attributes) {
    const scope = def.scope === 'variant' ? c.variant : c.product;
    scope.set(def.code, { def, check: checker(def) });
    if (def.required)
      (def.scope === 'variant' ? c.requiredVariant : c.requiredProduct).push(def.code);
  }
  compiled.set(id, c);
  return c;
}

function checkAttributes(
  values: Record<string, unknown>,
  defs: CompiledType['product'],
  required: string[],
  path: string,
  issues: Issue[],
) {
  for (const [code, value] of Object.entries(values)) {
    const entry = defs.get(code);
    if (!entry) {
      issues.push({ path: `${path}.${code}`, message: 'not an attribute of this type' });
      continue;
    }
    if (value === null) continue;
    const problem = entry.check(value);
    if (problem) issues.push({ path: `${path}.${code}`, message: problem });
  }
  for (const code of required)
    if (values[code] === undefined || values[code] === null)
      issues.push({ path: `${path}.${code}`, message: 'required' });
}

/**
 * Checks a product against its type and returns it with defaults applied and the type version
 * pinned. `resolveType` returns the named version, or the latest when `version` is undefined.
 */
export function validateProduct(
  input: ProductInput | unknown,
  resolveType: (code: string, version?: number) => ProductType | undefined,
): Validated {
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  const p = parsed.data;
  const ref = parseTypeRef(p.type);
  const type = resolveType(ref.code, ref.version);
  if (!type) return { ok: false, issues: [{ path: 'type', message: `unknown type ${p.type}` }] };
  const c = compileType(type);
  const issues: Issue[] = [];

  checkAttributes(p.attributes, c.product, c.requiredProduct, 'attributes', issues);
  const skus = new Set<string>();
  const combos = new Set<string>();
  p.variants.forEach((v, i) => {
    if (skus.has(v.sku)) issues.push({ path: `variants.${i}.sku`, message: 'duplicate SKU' });
    skus.add(v.sku);
    checkAttributes(v.attributes, c.variant, c.requiredVariant, `variants.${i}.attributes`, issues);
    if (type.variantAxes.length) {
      const combo = type.variantAxes.map((a) => String(v.attributes[a] ?? '')).join('\u0000');
      if (type.variantAxes.some((a) => v.attributes[a] === undefined))
        issues.push({ path: `variants.${i}`, message: `needs ${type.variantAxes.join(', ')}` });
      else if (combos.has(combo))
        issues.push({ path: `variants.${i}`, message: 'same options as another variant' });
      combos.add(combo);
    }
  });
  for (const [locale, slug] of Object.entries(p.slug ?? {}))
    if (slug.length > 200 || !SLUG.test(slug))
      issues.push({ path: `slug.${locale}`, message: 'lowercase words joined by "-"' });
  if (p.primaryCategory && !p.categories.includes(p.primaryCategory))
    issues.push({ path: 'primaryCategory', message: 'not one of categories' });
  if (p.extra && JSON.stringify(p.extra).length > LIMITS.extraBytes)
    issues.push({ path: 'extra', message: `over ${LIMITS.extraBytes} bytes` });
  if (issues.length) return { ok: false, issues };

  const data: ProductData = {
    ...p,
    type: type.code,
    typeVersion: type.version,
    primaryCategory: p.primaryCategory ?? p.categories[0],
  };
  if (JSON.stringify(data).length > LIMITS.productBytes)
    return { ok: false, issues: [{ path: '', message: `over ${LIMITS.productBytes} bytes` }] };
  return { ok: true, data };
}

/** The value for `locale`, else `fallback`'s, else any. */
export function pickLocale(
  value: Localized | undefined,
  locale: string,
  fallback: string,
): string | undefined {
  if (!value) return undefined;
  return value[locale] ?? value[fallback] ?? Object.values(value)[0];
}

/** Every alias a product claims: its variant SKUs and GTINs. Slugs are claimed per locale. */
export function productAliases(p: Pick<ProductData, 'variants' | 'slug'>): string[] {
  const out: string[] = [];
  for (const v of p.variants) {
    out.push(`sku:${v.sku}`);
    if (v.gtin) out.push(`gtin:${v.gtin}`);
  }
  for (const [locale, slug] of Object.entries(p.slug ?? {})) out.push(`slug:${locale}:${slug}`);
  return out;
}
