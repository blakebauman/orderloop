/**
 * SAP OCI 4.0 (Open Catalog Interface): the buyer's system opens the catalog with its user, password
 * and HOOK_URL, and the cart goes back as form fields posted to HOOK_URL, one set per line, indexed
 * from 1: `NEW_ITEM-DESCRIPTION[1]`, `NEW_ITEM-QUANTITY[1]`, ….
 *
 * SAP also sends control fields it expects back with the cart: `~OkCode` (what to do with it,
 * `ADDI` to add the items), `~TARGET` (the frame to post into, `_top` say) and `~CALLER` (`CTLG`,
 * a catalog). They're echoed as sent, when they're short and plain; `~OkCode` and `~CALLER`
 * otherwise fall back to the spec's values, and `~TARGET` is left out.
 */

/** The control fields a return echoes. */
export type OciControl = { okCode: string; caller: string; target?: string };

export type OciSetup = { username: string; password: string; hookUrl: string; control: OciControl };

// A control value is echoed into the buyer's system, so only a short word passes: anything else is
// dropped rather than cleaned up.
const CONTROL_VALUE = /^[A-Za-z0-9_-]{1,20}$/;
const control = (v: unknown) => (typeof v === 'string' && CONTROL_VALUE.test(v) ? v : undefined);

/** The control fields to echo, from what SAP sent (or, for a session that kept none, the defaults). */
export function ociControl(sent: { okCode?: unknown; caller?: unknown; target?: unknown } = {}) {
  const target = control(sent.target);
  return {
    okCode: control(sent.okCode) ?? 'ADDI',
    caller: control(sent.caller) ?? 'CTLG',
    ...(target ? { target } : {}),
  } satisfies OciControl;
}

/** A session's stored control fields (`sessions.oci_control`), checked; the defaults if unreadable. */
export function storedOciControl(raw: string | null): OciControl {
  let sent: unknown;
  try {
    sent = raw ? JSON.parse(raw) : undefined;
  } catch {
    sent = undefined;
  }
  return ociControl(sent && typeof sent === 'object' ? sent : undefined);
}

export function parseOciSetup(params: URLSearchParams): OciSetup | null {
  const get = (k: string) => params.get(k) ?? params.get(k.toLowerCase()) ?? '';
  const username = get('USERNAME');
  const password = get('PASSWORD');
  const hookUrl = get('HOOK_URL');
  if (!username || !password || !hookUrl) return null;
  // SAP spells these `~OkCode`, `~TARGET` and `~CALLER`, but systems differ in case.
  // The last one sent wins, as for the other fields: a POST's body comes after its query string.
  const tilde = (name: string) => {
    let found: string | undefined;
    for (const [k, v] of params) if (k.toLowerCase() === name) found = v;
    return found;
  };
  return {
    username,
    password,
    hookUrl,
    control: ociControl({
      okCode: tilde('~okcode'),
      caller: tilde('~caller'),
      target: tilde('~target'),
    }),
  };
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

export function ociFields(lines: OciLine[], ctl: OciControl): Record<string, string> {
  const out: Record<string, string> = {
    '~OkCode': ctl.okCode,
    ...(ctl.target ? { '~TARGET': ctl.target } : {}),
    '~CALLER': ctl.caller,
  };
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
