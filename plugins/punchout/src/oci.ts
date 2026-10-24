/**
 * SAP OCI 4.0 (Open Catalog Interface): the buyer's system opens the catalog with its user, password
 * and HOOK_URL, and the cart goes back as form fields posted to HOOK_URL, one set per line, indexed
 * from 1: `NEW_ITEM-DESCRIPTION[1]`, `NEW_ITEM-QUANTITY[1]`, ….
 */

export type OciSetup = { username: string; password: string; hookUrl: string };

export function parseOciSetup(params: URLSearchParams): OciSetup | null {
  const get = (k: string) => params.get(k) ?? params.get(k.toLowerCase()) ?? '';
  const username = get('USERNAME');
  const password = get('PASSWORD');
  const hookUrl = get('HOOK_URL');
  return username && password && hookUrl ? { username, password, hookUrl } : null;
}

export type OciLine = {
  sku: string;
  description: string;
  qty: number;
  unitPrice: number;
  currency: string;
  unit?: string;
  /** Ours, to find the cart line again; OCI carries it in NEW_ITEM-EXT_PRODUCT_ID. */
  ref: string;
};

const amount = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function ociFields(lines: OciLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  lines.forEach((l, i) => {
    const n = i + 1;
    const set = (k: string, v: string) => {
      out[`NEW_ITEM-${k}[${n}]`] = v;
    };
    set('DESCRIPTION', l.description.slice(0, 40));
    set('QUANTITY', String(l.qty));
    set('UNIT', l.unit ?? 'EA');
    set('PRICE', amount(l.unitPrice));
    set('PRICEUNIT', '1');
    set('CURRENCY', l.currency);
    set('VENDORMAT', l.sku);
    set('EXT_PRODUCT_ID', l.ref);
  });
  return out;
}
