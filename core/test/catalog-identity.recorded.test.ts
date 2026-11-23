import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseSearchResponse } from '../src/keepa/parse';
import { checkIdentity, dewaltAmpHourConflict, identityFromKeepa, identityFromSerpProduct } from '../src/keepa/verify';
import { wantedFor } from '../src/scan/classify';
import { ampHourConflicts, measureIdentity } from '../../scripts/measure-identity';

// The catalog check (core/src/keepa/verify.ts) on the recorded Keepa products and SerpApi pages. No network.

const search = parseSearchResponse(JSON.parse(readFileSync('fixtures/keepa/search-RYOBI-PCL235B.json', 'utf8'))).products ?? [];
const product = (asin: string) => identityFromKeepa(search.find((p) => p.asin === asin)!);
const want = (brand: string, model: string) => wantedFor(brand, model, new Map());

describe('checkIdentity on recorded Keepa products', () => {
  it('confirms the PCL235B listing from its brand and part number fields', () => {
    expect(checkIdentity(want('RYOBI', 'PCL235B'), product('B0BGYFTPGK'))).toEqual({
      status: 'confirmed', reason: "Amazon's catalog lists brand RYOBI, part number PCL235B",
    });
  });

  it('confirms the same listing for PCL235, the form Home Depot writes (RYOBI tool-only B)', () => {
    expect(checkIdentity(want('RYOBI', 'PCL235'), product('B0BGYFTPGK')).status).toBe('confirmed');
  });

  it('contradicts another brand: a hard case and a bit set made for the tool', () => {
    expect(checkIdentity(want('RYOBI', 'PCL235B'), product('B0HFS4PFLN'))).toEqual({ status: 'contradicted', reason: "Amazon's catalog lists brand Tourmate, not RYOBI" });
    expect(checkIdentity(want('RYOBI', 'PCL235B'), product('B0HL8FNQB5')).status).toBe('contradicted');
  });

  it('contradicts another part number of the brand', () => {
    expect(checkIdentity(want('RYOBI', 'PCL235B'), product('B0FD1B8BG5'))).toEqual({ status: 'contradicted', reason: "Amazon's catalog lists part number PCL201, not PCL235B" });
  });

  it('a seller brand over the maker is unknown, not contradicted (B0BL8BC8MF: FIRE ROSE, made by Ryobi; the validation key says it is PCL265B)', () => {
    expect(checkIdentity(want('RYOBI', 'PCL265B'), product('B0BL8BC8MF'))).toEqual({ status: 'unknown', reason: "Amazon's catalog lists brand FIRE ROSE, made by Ryobi" });
  });

  it('a part number match with a kit title is not confirmed (B0DNNZ1W52: part number PCL540, Kit with Battery and Charger)', () => {
    expect(checkIdentity(want('RYOBI', 'PCL540'), product('B0DNNZ1W52'))).toEqual({ status: 'unknown', reason: 'title sells it with a battery, a charger or more' });
  });

  it('a variant part number is unknown, never contradicted (PCL001K for PCL001B)', () => {
    expect(checkIdentity(want('RYOBI', 'PCL001B'), product('B0DY31QJ4Q')).status).toBe('unknown');
  });

  it('a manufacturer that is not the brand stops a confirmation (B08L38QFFW: brand RYOBI, manufacturer Partyreal)', () => {
    expect(checkIdentity(want('RYOBI', 'PSBDD01'), product('B08L38QFFW'))).toEqual({ status: 'unknown', reason: "Amazon's catalog lists brand RYOBI but manufacturer Partyreal" });
  });

  it('the model field confirms when the part number field is a shorter form (B09SN6Y6TS: part number P215, model P215BN)', () => {
    expect(checkIdentity(want('RYOBI', 'P215BN'), product('B09SN6Y6TS'))).toEqual({ status: 'confirmed', reason: "Amazon's catalog lists brand RYOBI, model number P215BN" });
  });

  it('a title alone never confirms: a search row with no part number is unknown', () => {
    const row = { ...product('B0BGYFTPGK'), partNumber: null, model: null };
    expect(checkIdentity(want('RYOBI', 'PCL235B'), row).status).toBe('unknown');
  });

  it('a package of more than one, for a single part, is not confirmed', () => {
    expect(checkIdentity(want('RYOBI', 'PCL235B'), { ...product('B0BGYFTPGK'), packageQuantity: 2 })).toEqual({
      status: 'unknown', reason: "Amazon's catalog lists a package of 2",
    });
  });
});

describe('checkIdentity on recorded SerpApi product pages', () => {
  it('reads brand, manufacturer part number and counts from amazon_product (B0B3JWF5ZV)', () => {
    const l = identityFromSerpProduct(JSON.parse(readFileSync('fixtures/recorded/amazon-product-B0B3JWF5ZV.json', 'utf8')), 'B0B3JWF5ZV')!;
    expect(l).toMatchObject({ brand: 'Brand: RYOBI', manufacturer: 'RYOBI', partNumber: 'PBLRC25B', model: '#PBLRC25B', numberOfItems: 1, source: 'serpapi_product' });
    expect(checkIdentity(want('RYOBI', 'PBLRC25B'), l)).toEqual({ status: 'confirmed', reason: "Amazon's product page lists brand RYOBI, part number PBLRC25B" });
  });
});

describe('the DEWALT amp-hour rule', () => {
  it('B0GQ6QKPWF says 5Ah; a DCK540D1 holds one D (2.0Ah) battery', () => {
    expect(dewaltAmpHourConflict('DCK540D1', '20V MAX 5-Tool Power Tools Combo Kit, Includes ..., 5Ah Battery and Charger (DCK540D1)')).toBe(
      'title says 5Ah, but in DCK540D1 D is 2.0Ah',
    );
  });

  it('agrees with a C2 kit at 1.3Ah and reads nothing from an unknown letter', () => {
    expect(dewaltAmpHourConflict('DCK240C2', '20V MAX Cordless Drill/Impact Combo Kit (1.3Ah) (DCK240C2)')).toBeNull();
    expect(dewaltAmpHourConflict('DCK316ST2M1', 'Combo Kit with 5Ah Battery')).toBeNull();
  });
});

describe('measured on every recorded example (scripts/measure-identity.ts)', () => {
  const { scores } = measureIdentity();
  const by = Object.fromEntries(scores.map((s) => [s.set, s]));

  it('is never wrong', () => {
    expect(scores.map((s) => [s.set, s.wrong])).toEqual(scores.map((s) => [s.set, 0]));
  });

  it('the numbers recorded in docs/decisions.md', () => {
    expect(scores.map(({ set, rows, right, wrong, unknown, uncertain }) => ({ set, rows, right, wrong, unknown, uncertain }))).toEqual([
      { set: 'keepa-for-PCL235B', rows: 20, right: 16, wrong: 0, unknown: 4, uncertain: 0 },
      { set: 'keepa-own-model', rows: 22, right: 10, wrong: 0, unknown: 6, uncertain: 6 },
      { set: 'keepa-pulls', rows: 3, right: 3, wrong: 0, unknown: 0, uncertain: 0 },
      { set: 'serpapi-pages', rows: 2, right: 2, wrong: 0, unknown: 0, uncertain: 0 },
      { set: 'validation-rows', rows: 279, right: 34, wrong: 0, unknown: 227, uncertain: 18 },
    ]);
    // Search rows carry no part number: the check never confirms one.
    expect(by['validation-rows']!.confirmed).toBe(0);
  });

  it('the amp-hour rule keeps one listing the validation key calls right unknown: DCK540D1 on B0GQ6QKPWF', () => {
    expect(ampHourConflicts().map((c) => `${c.asin} ${c.model}`)).toEqual(['B0GQ6QKPWF DCK540D1']);
  });
});
