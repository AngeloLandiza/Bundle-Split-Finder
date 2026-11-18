import { describe, expect, it } from 'vitest';

import { pick } from '../src/match';
import { candidatesFor, listingFrom, modelsInTitle } from '../src/scan/listings';
import type { ListingRecord } from '../src/scan/types';
import { amazonHasNextPage, parseAmazonSearch } from '../src/serpapi/parsers';
import { recorded } from './recorded';

// Every row here is a recorded SerpApi response (fixtures/recorded/). Nothing reaches the network.

const BRANDS = ['DEWALT', 'RYOBI'];
const NOW = Date.UTC(2026, 10, 9, 12);
const dewaltPage = () => parseAmazonSearch(recorded('amazon-brand-dewalt-p1'));
const ryobiPage = () => parseAmazonSearch(recorded('amazon-brand-ryobi-p1'));
const row = (rows: ReturnType<typeof dewaltPage>, asin: string) => rows.find((r) => r.asin === asin)!;

describe('modelsInTitle', () => {
  it.each([
    ['DEWALT', '20V MAX Cordless Drill and Impact Driver (DCK240C2)', ['DCK240C2']],
    ['DEWALT', '20V MAX 5 Ah Lithium Ion Battery 2-Pack (DCB205-2)', ['DCB205-2']],
    ['DEWALT', 'NA020584 Impact Wrench Gearcase for DeWalt DCF891N, DCF891B', ['DCF891N', 'DCF891B']],
    ['DEWALT', '20V MAX Battery XR POWERPACK 4Ah Lithium Ion', []],
    ['RYOBI', 'ONEAND HP 18V BRUSHLESS Cordless 3/8 in. Extended Reach Ratchet Tool ONLY PBLRC25B', ['PBLRC25B']],
    ['RYOBI', 'ONE+ 18V Lithium-Ion 4.0 Ah Battery (2-Pack) and Charger Kit, 1 (PSK006)', ['PSK006']],
    ['RYOBI', 'P1819 18V One+ Lithium Ion Combo Kit (6 Tools: Drill/Driver, Impact Driver)', ['P1819']],
    ['RYOBI', '18V Drill Set with Lithium-Ion Battery, Charger, Bits & Bag', []],
    ['RYOBI', 'R18PI-0 18V ONE+ Cordless High Pressure Inflator (Body Only)', []],
    ['RYOBI', 'pcl430b and PCL430B twice', ['PCL430B']],
    ['Milwaukee', 'M12 FUEL 3050-20 PBLRC25B', []],
  ] as const)('modelsInTitle(%s, %s)', (brand, title, models) => expect(modelsInTitle(brand, title)).toEqual(models));

  it('finds a model on 40 of the 60 recorded DEWALT rows and 17 of the 51 recorded RYOBI rows', () => {
    const dewalt = dewaltPage().filter((r) => r.brand === 'DEWALT');
    const ryobi = ryobiPage().filter((r) => r.brand === 'RYOBI');
    expect(dewalt).toHaveLength(60);
    expect(ryobi).toHaveLength(51);
    expect(dewalt.filter((r) => modelsInTitle('DEWALT', r.title).length > 0)).toHaveLength(40);
    expect(ryobi.filter((r) => modelsInTitle('RYOBI', r.title).length > 0)).toHaveLength(17);
  });

  it('never calls a plain word a model on the recorded pages', () => {
    const found = [
      ...dewaltPage().flatMap((r) => modelsInTitle('DEWALT', r.title)),
      ...ryobiPage().flatMap((r) => modelsInTitle('RYOBI', r.title)),
    ];
    // Every row of both pages: 40 DEWALT and 17 RYOBI models, and PSK006 and PBP004 from
    // RYOBI-page rows that have no brand.
    expect(found).toHaveLength(59);
    for (const model of found) {
      expect(model).toMatch(/\d{2,}/);
      expect(model.length).toBeGreaterThanOrEqual(4);
    }
    // Real RYOBI models of four characters.
    expect(found).toContain('P505');
    expect(found).toContain('P590');
  });
});

describe('amazonHasNextPage', () => {
  it('reads serpapi_pagination.next', () => {
    expect(amazonHasNextPage(recorded('amazon-brand-dewalt-p1'))).toBe(true);
    expect(amazonHasNextPage(recorded('amazon-brand-ryobi-p1'))).toBe(true);
    expect(amazonHasNextPage(recorded('amazon-search-PBLRC25B'))).toBe(false);
  });

  it('is false for an empty or missing next link', () => {
    expect(amazonHasNextPage({ serpapi_pagination: { current: 1, next: '' } })).toBe(false);
    expect(amazonHasNextPage({ serpapi_pagination: { current: 1 } })).toBe(false);
    expect(amazonHasNextPage(null)).toBe(false);
  });
});

describe('parseAmazonSearch: pictures', () => {
  it('reads every recorded row\'s thumbnail as its image', () => {
    const rows = dewaltPage();
    expect(rows.every((r) => typeof r.image === 'string' && r.image.length > 0)).toBe(true);
    expect(row(rows, 'B00IJ0ALYS').image).toBe((recorded('amazon-brand-dewalt-p1') as { organic_results: { thumbnail: string }[] }).organic_results[1]!.thumbnail);
  });

  it('gives null when a row has no thumbnail', () => {
    expect(parseAmazonSearch({ organic_results: [{ asin: 'A1', title: 'T' }, { asin: 'A2', title: 'T', thumbnail: '' }] }).map((r) => r.image)).toEqual([null, null]);
  });
});

describe('listingFrom', () => {
  it('saves a row of a scanned brand, with its picture and its list price (step 9)', () => {
    const c = row(dewaltPage(), 'B00IJ0ALYS');
    const saved = listingFrom(c, BRANDS, NOW);
    expect(saved).toEqual({
      asin: 'B00IJ0ALYS', brand: 'DEWALT', title: '20V MAX Cordless Drill and Impact Driver (DCK240C2)', models: ['DCK240C2'],
      image: expect.any(String), price: 149, reviews: 61300, seenAt: NOW, checkedAt: NOW, listPrice: 239,
    });
    expect(saved!.image!.length).toBeGreaterThan(0);
  });

  it('does not save a row with no brand, another brand, or Amazon Renewed', () => {
    const noBrand = ryobiPage().find((r) => r.brand === null)!;
    expect(noBrand).toBeDefined();
    expect(listingFrom(noBrand, BRANDS, NOW)).toBeNull();
    // A DEWALT row while only RYOBI is scanned.
    expect(listingFrom(row(dewaltPage(), 'B00IJ0ALYS'), ['RYOBI'], NOW)).toBeNull();
    const renewed = parseAmazonSearch(recorded('amazon-search-PBLRC25B')).find((r) => r.brand === 'Amazon Renewed')!;
    expect(renewed).toBeDefined();
    expect(listingFrom(renewed, BRANDS, NOW)).toBeNull();
  });

  it('compares brands upper-cased and trimmed', () => {
    const c = { ...row(dewaltPage(), 'B00IJ0ALYS'), brand: ' DeWalt ' };
    expect(listingFrom(c, [' dewalt'], NOW)).toMatchObject({ brand: 'DEWALT', models: ['DCK240C2'] });
  });

  it('keeps the last price when the listing is seen again without one', () => {
    const c = row(dewaltPage(), 'B00IJ0ALYS');
    const old = listingFrom(c, BRANDS, 1)!;
    expect(old).toMatchObject({ price: 149, seenAt: 1, checkedAt: 1 });
    const again = listingFrom({ ...c, price: null, reviews: 61400 }, BRANDS, 5, old);
    expect(again).toMatchObject({ price: 149, seenAt: 1, checkedAt: 5, reviews: 61400 });
  });

  it('takes a new price and moves seenAt when the row has one', () => {
    const c = row(dewaltPage(), 'B00IJ0ALYS');
    const old: ListingRecord = { ...listingFrom(c, BRANDS, 1)!, price: 199 };
    expect(listingFrom(c, BRANDS, 5, old)).toMatchObject({ price: 149, seenAt: 5, checkedAt: 5 });
  });

  it('keeps the old picture when the row has none, and takes a new one when it has', () => {
    const c = row(dewaltPage(), 'B00IJ0ALYS');
    const old = listingFrom(c, BRANDS, 1)!;
    expect(listingFrom({ ...c, image: null }, BRANDS, 5, old)!.image).toBe(old.image);
    expect(listingFrom({ ...c, image: 'https://m.media-amazon.com/images/I/new.jpg' }, BRANDS, 5, old)!.image).toBe('https://m.media-amazon.com/images/I/new.jpg');
    expect(listingFrom({ ...c, image: null }, BRANDS, 5)!.image).toBeNull();
  });
});

describe('candidatesFor', () => {
  const saved = () => dewaltPage().map((c) => listingFrom(c, BRANDS, NOW)).filter((l): l is ListingRecord => l !== null);

  it('offers saved listings for a part by whole model token only', () => {
    const listings = saved();
    expect(listings).toHaveLength(60);
    expect(candidatesFor('DEWALT', 'DCS334B', listings).map((c) => c.asin)).toEqual(['B07JPFHQKG']);
    expect(candidatesFor('DEWALT', 'DCS334', listings)).toEqual([]);
  });

  it('carries what pick() reads, from the saved listing', () => {
    const listings = saved();
    const [c] = candidatesFor('DEWALT', 'DCS334B', listings);
    const l = listings.find((x) => x.asin === 'B07JPFHQKG')!;
    expect(c).toEqual({ asin: 'B07JPFHQKG', title: l.title, brand: 'DEWALT', price: 123, reviews: l.reviews, image: l.image });
    // The same grade a search result with this row would get.
    expect(pick({ brand: 'DEWALT', model: 'DCS334B' }, [c!]).chosen).toMatchObject({ asin: 'B07JPFHQKG', grade: 'probable' });
  });

  it('offers only listings of the part\'s brand', () => {
    expect(candidatesFor('RYOBI', 'DCS334B', saved())).toEqual([]);
    expect(candidatesFor(' dewalt ', 'dcs334b', saved()).map((c) => c.asin)).toEqual(['B07JPFHQKG']);
  });
});
