import { describe, expect, it } from 'vitest';
import { checkAddress, rememberedAddress } from '../src/address';

const clean = {
  line1: '1 Main St',
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
};

describe('checkAddress', () => {
  it('accepts a clean address as is', () => {
    expect(checkAddress(clean)).toEqual({ status: 'valid', address: clean, issues: [] });
    const gb = { line1: '10 Downing St', city: 'London', postalCode: 'SW1A 2AA', country: 'GB' };
    expect(checkAddress(gb).status).toBe('valid');
  });

  it('corrects whitespace, country aliases, region names and postcode format', () => {
    expect(
      checkAddress({
        line1: '  1   Main St ',
        city: 'Springfield',
        region: 'illinois',
        postalCode: '627011234',
        country: 'usa',
      }),
    ).toEqual({
      status: 'corrected',
      address: { ...clean, postalCode: '62701-1234' },
      issues: [],
    });
    expect(
      checkAddress({
        line1: '290 Bremner Blvd',
        city: 'Toronto',
        region: 'Ontario',
        postalCode: 'm5v3l9',
        country: 'Canada',
      }).address,
    ).toMatchObject({ region: 'ON', postalCode: 'M5V 3L9', country: 'CA' });
    expect(
      checkAddress({ line1: '10 Downing St', city: 'London', postalCode: 'sw1a2aa', country: 'UK' })
        .address,
    ).toMatchObject({ postalCode: 'SW1A 2AA', country: 'GB' });
  });

  it('drops fields it does not know and still reports a clean address as corrected', () => {
    const r = checkAddress({ ...clean, line2: '   ', phone: '555' });
    expect(r).toEqual({ status: 'corrected', address: clean, issues: [] });
  });

  it('rejects what it cannot fix, listing every problem', () => {
    expect(checkAddress(undefined)).toMatchObject({
      status: 'invalid',
      issues: ['No ship-to address'],
    });
    expect(checkAddress('1 Main St, Springfield').issues[0]).toMatch(/free text/);
    const r = checkAddress({
      line1: '1 Main St',
      region: 'Narnia',
      postalCode: '1234',
      country: 'us',
    });
    expect(r.status).toBe('invalid');
    expect(r.issues).toEqual([
      'Missing city',
      'Unknown region "Narnia" for US',
      'Postcode "1234" is not valid for US',
    ]);
    expect(r.address).toMatchObject({ country: 'US' });
    expect(checkAddress({ ...clean, country: 'Atlantis' }).issues).toEqual([
      'Unknown country "Atlantis"; use a two-letter code',
    ]);
    expect(checkAddress({ ...clean, region: undefined }).issues).toEqual([
      'Missing state or province',
    ]);
  });

  it('only checks that other countries have a postcode', () => {
    const fr = { line1: '5 Av. Anatole France', city: 'Paris', postalCode: '75007', country: 'FR' };
    expect(checkAddress(fr).status).toBe('valid');
  });
});

describe('rememberedAddress', () => {
  it('keys the normalised place, not its spelling or the recipient', () => {
    const a = rememberedAddress({ ...clean, name: 'Ann' });
    const b = rememberedAddress({
      name: 'Bo',
      line1: ' 1  main st ',
      city: 'springfield',
      region: 'Illinois',
      postalCode: '62701',
      country: 'USA',
    });
    expect(a?.key).toBe('1 main st||springfield|il|62701|us');
    expect(b?.key).toBe(a?.key);
    expect(b?.address.name).toBe('Bo');
  });

  it('remembers nothing it could not use', () => {
    expect(rememberedAddress('1 Main St, Springfield')).toBeNull();
    expect(rememberedAddress({ line1: '1 Main St' })).toBeNull();
    expect(rememberedAddress(undefined)).toBeNull();
  });
});
