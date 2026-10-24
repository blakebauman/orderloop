/**
 * What a channel's listing indexes contain, from the catalog's product types: every filterable term
 * attribute (and `brand`), every filterable or sortable numeric attribute (and `price`), the sorts
 * and range buckets the types declare, and labels in each of the channel's locales. Pure.
 */
import type { ListingSpec } from './listing-index';
import type { Channel, ProductType } from './model';
import { NUMERIC_KINDS, TERM_KINDS } from './model';
import { pickLocale } from './validate';

export function listingSpec(types: ProductType[], channel: Channel): ListingSpec {
  // Only each type's latest version: it holds every attribute any earlier one did.
  const latest = new Map<string, ProductType>();
  for (const t of types) if ((latest.get(t.code)?.version ?? 0) < t.version) latest.set(t.code, t);
  const terms = new Set<string>(['brand']);
  const numbers = new Set<string>(['price']);
  const sorts = new Set<string>(['price']);
  const buckets: Record<string, number[]> = {};
  const defs = [...latest.values()].flatMap((t) => t.attributes);
  for (const a of defs) {
    if (a.filterable && TERM_KINDS.includes(a.kind) && !a.localized) terms.add(a.code);
    if ((a.filterable || a.sortable) && NUMERIC_KINDS.includes(a.kind)) numbers.add(a.code);
    if (a.sortable && NUMERIC_KINDS.includes(a.kind)) sorts.add(a.code);
    if (a.buckets?.length && NUMERIC_KINDS.includes(a.kind)) buckets[a.code] = a.buckets;
  }
  const labels: NonNullable<ListingSpec['labels']> = {};
  for (const locale of channel.locales) {
    const attributes: Record<string, string> = {};
    const values: Record<string, Record<string, string>> = {};
    for (const a of defs) {
      if (!terms.has(a.code) && !numbers.has(a.code)) continue;
      const label = pickLocale(a.label, locale, channel.defaultLocale);
      if (label) attributes[a.code] = label;
      for (const v of a.values ?? []) {
        const vl = pickLocale(v.label, locale, channel.defaultLocale);
        if (!vl) continue;
        const forAttr = values[a.code] ?? {};
        forAttr[v.code] = vl;
        values[a.code] = forAttr;
      }
    }
    labels[locale] = { attributes, values };
  }
  return { terms: [...terms], numbers: [...numbers], sorts: [...sorts], buckets, labels };
}
