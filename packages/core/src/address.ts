/**
 * Ship-to address checks for the `commerce.address_validate` node. Pure and deterministic: it
 * normalises what it can (whitespace, country aliases, region names, postcode formatting) and
 * says whether the address was already clean, could be corrected, or can't be used. A real
 * provider (USPS, Loqate) replaces it behind the engine's `validateAddress` connector.
 */

export type ShipAddress = {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
};

export type AddressCheck = {
  status: 'valid' | 'corrected' | 'invalid';
  /** The normalised address; for `invalid`, as far as it could be normalised. */
  address: Partial<ShipAddress> | null;
  issues: string[];
};

const FIELDS = ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const;
const REQUIRED = ['line1', 'city', 'postalCode', 'country'] as const;
const LABEL: Record<(typeof REQUIRED)[number], string> = {
  line1: 'street address',
  city: 'city',
  postalCode: 'postcode',
  country: 'country',
};

const COUNTRY_ALIASES: Record<string, string> = {
  USA: 'US',
  'U.S.': 'US',
  'U.S.A.': 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  CANADA: 'CA',
  UK: 'GB',
  'UNITED KINGDOM': 'GB',
  'GREAT BRITAIN': 'GB',
  AUSTRALIA: 'AU',
  GERMANY: 'DE',
  DEUTSCHLAND: 'DE',
};

const US_STATES: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'PUERTO RICO': 'PR',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
};
const CA_PROVINCES: Record<string, string> = {
  ALBERTA: 'AB',
  'BRITISH COLUMBIA': 'BC',
  MANITOBA: 'MB',
  'NEW BRUNSWICK': 'NB',
  'NEWFOUNDLAND AND LABRADOR': 'NL',
  'NORTHWEST TERRITORIES': 'NT',
  'NOVA SCOTIA': 'NS',
  NUNAVUT: 'NU',
  ONTARIO: 'ON',
  'PRINCE EDWARD ISLAND': 'PE',
  QUEBEC: 'QC',
  SASKATCHEWAN: 'SK',
  YUKON: 'YT',
};
const AU_STATES: Record<string, string> = {
  'AUSTRALIAN CAPITAL TERRITORY': 'ACT',
  'NEW SOUTH WALES': 'NSW',
  'NORTHERN TERRITORY': 'NT',
  QUEENSLAND: 'QLD',
  'SOUTH AUSTRALIA': 'SA',
  TASMANIA: 'TAS',
  VICTORIA: 'VIC',
  'WESTERN AUSTRALIA': 'WA',
};
/** Countries whose addresses need a region, and the names each accepts in place of a code. */
const REGIONS: Record<string, Record<string, string>> = {
  US: US_STATES,
  CA: CA_PROVINCES,
  AU: AU_STATES,
};

/** The region codes a country's addresses use (`US` → `AL`, `AK`, …), or null when it has none listed. */
export function regionCodes(country: string): string[] | null {
  const names = REGIONS[country];
  return names ? [...new Set(Object.values(names))] : null;
}

/** Returns the formatted postcode, or null when it isn't valid for the country. */
function postcode(country: string, raw: string): string | null {
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  switch (country) {
    case 'US': {
      const digits = compact.replace(/-/g, '');
      if (/^\d{5}$/.test(digits)) return digits;
      if (/^\d{9}$/.test(digits)) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
      return null;
    }
    case 'CA':
      return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)
        ? `${compact.slice(0, 3)} ${compact.slice(3)}`
        : null;
    case 'GB':
      return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)
        ? `${compact.slice(0, -3)} ${compact.slice(-3)}`
        : null;
    case 'AU':
      return /^\d{4}$/.test(compact) ? compact : null;
    case 'DE':
      return /^\d{5}$/.test(compact) ? compact : null;
    default:
      return raw;
  }
}

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export function checkAddress(input: unknown): AddressCheck {
  if (input === undefined || input === null || input === '')
    return { status: 'invalid', address: null, issues: ['No ship-to address'] };
  if (typeof input !== 'object' || Array.isArray(input))
    return {
      status: 'invalid',
      address: null,
      issues: ['Ship-to is free text; expected line1, city, postalCode and country'],
    };

  const raw = input as Record<string, unknown>;
  const out: Partial<ShipAddress> = {};
  for (const f of FIELDS) {
    const v = clean(raw[f]);
    if (v) out[f] = v;
  }
  const issues: string[] = [];
  for (const f of REQUIRED) if (!out[f]) issues.push(`Missing ${LABEL[f]}`);

  if (out.country) {
    const upper = out.country.toUpperCase();
    const code = COUNTRY_ALIASES[upper] ?? upper;
    if (/^[A-Z]{2}$/.test(code)) out.country = code;
    else issues.push(`Unknown country "${out.country}"; use a two-letter code`);
  }
  const country = out.country && /^[A-Z]{2}$/.test(out.country) ? out.country : null;

  const names = country ? REGIONS[country] : undefined;
  if (names) {
    const upper = out.region?.toUpperCase();
    const code = upper ? (names[upper] ?? upper) : undefined;
    if (!code) issues.push('Missing state or province');
    else if (!Object.values(names).includes(code))
      issues.push(`Unknown region "${out.region}" for ${country}`);
    else out.region = code;
  }

  if (country && out.postalCode) {
    const p = postcode(country, out.postalCode);
    if (p === null) issues.push(`Postcode "${out.postalCode}" is not valid for ${country}`);
    else out.postalCode = p;
  }

  if (issues.length) return { status: 'invalid', address: out, issues };
  const changed = FIELDS.some((f) => (out[f] ?? '') !== (typeof raw[f] === 'string' ? raw[f] : ''));
  return { status: changed ? 'corrected' : 'valid', address: out, issues: [] };
}
