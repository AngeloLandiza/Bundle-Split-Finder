// Product pictures (core/src/links/pictures.ts): a stored address is shown only on the hosts the CSP names
// (agent/test/pictureCsp.test.ts checks the CSP). The addresses are real ones: Amazon's from
// fixtures/e2e-2026-11-23/after-scan6/scan/listings.json, Home Depot's from fixtures/recorded/hd-bundles-ryobi-p1.json.
import { describe, expect, it } from 'vitest';

import { amazonPicture, coverageSentence, homeDepotPicture, partPicture, pictureCoverage, pictureUrl, rowPicture } from '../src/links/pictures';

const REAL = 'https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg';
const KEEPA = 'https://m.media-amazon.com/images/I/41w-+fzrg3L.jpg';
const HD = 'https://images.thdstatic.com/productImages/b16b4743-d4cf-4c84-b731-5ccd3e2cc507/svn/ryobi-power-tool-combo-kits-pcl1600k2-64_145.jpg';

describe('a stored picture', () => {
  it('is shown from the image hosts the stored records hold', () => {
    expect(pictureUrl(REAL)).toBe(REAL);
    expect(pictureUrl(KEEPA)).toBe(KEEPA);
    expect(pictureUrl(HD)).toBe(HD);
  });

  it.each([
    ['none', null],
    ['empty', ''],
    ['plain http', 'http://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg'],
    ['another host', 'https://images-na.ssl-images-amazon.com/images/I/81XPDrUh9sL.jpg'],
    ['another Home Depot host', 'https://inlinecontent.thdstatic.com/25H/ONE WORLD TECHNOLOGIES I/2966282.jpg'],
    ['a lookalike', 'https://m.media-amazon.com.evil.example/images/I/x.jpg'],
    ['a Home Depot lookalike', 'https://images.thdstatic.com.evil.example/x.jpg'],
    ['a user name', 'https://m.media-amazon.com@evil.example/x.jpg'],
    ['a port', 'https://m.media-amazon.com:444/images/I/x.jpg'],
    ['data', 'data:image/png;base64,iVBORw0KGgo='],
    ['javascript', 'javascript:alert(1)'],
    ['a space', 'https://m.media-amazon.com/images/I/a b.jpg'],
    ['a quote', 'https://m.media-amazon.com/images/I/a".jpg'],
    ['too long', `https://m.media-amazon.com/images/I/${'a'.repeat(300)}.jpg`],
  ])('is not shown when it is %s', (_name, url) => expect(pictureUrl(url)).toBeNull());

  it('is kept by each source only on its own host', () => {
    expect(amazonPicture(REAL)).toBe(REAL);
    expect(amazonPicture(HD)).toBeNull();
    expect(homeDepotPicture(HD)).toBe(HD);
    expect(homeDepotPicture(REAL)).toBeNull();
    expect(homeDepotPicture(42)).toBeNull();
  });
});

describe('the picture a deal shows', () => {
  it('is the bundle’s own Home Depot picture first', () => {
    expect(rowPicture(HD, [{ image: REAL }])).toBe(HD);
  });

  it('is the first part’s without one, and only the first part’s', () => {
    expect(rowPicture(null, [{ image: REAL }, { image: null }])).toBe(REAL);
    expect(rowPicture(undefined, [{ image: null }, { image: REAL }])).toBeNull();
    expect(rowPicture(null, [])).toBeNull();
  });

  it('takes a part’s own Home Depot picture when its Amazon listing has none', () => {
    expect(partPicture({ image: null, hdImage: HD })).toBe(HD);
    expect(partPicture({ image: REAL, hdImage: HD })).toBe(REAL);
    expect(rowPicture(null, [{ image: null, hdImage: HD }])).toBe(HD);
  });

  it('is none when the stored address is not on an image host', () => {
    expect(rowPicture('https://evil.example/x.jpg', [{ image: null }])).toBeNull();
  });
});

describe('picture coverage', () => {
  it('counts deals whose row shows a picture and distinct parts that have one', () => {
    const c = pictureCoverage([
      { brand: 'RYOBI', image: HD, parts: [{ model: 'PCL235B', image: null }] },
      { brand: 'RYOBI', parts: [{ model: 'PCL235B', image: REAL }, { model: 'PBP005', image: null }] },
      { brand: 'DEWALT', parts: [{ model: 'DCF921B', image: null }] },
    ]);
    expect(c).toEqual({ deals: 2, dealsOf: 3, parts: 1, partsOf: 3 });
    expect(coverageSentence(c)).toBe('Pictures for 2 of 3 deals and 1 of 3 parts.');
  });

  it('says nothing before any deal is stored', () => {
    expect(coverageSentence(pictureCoverage([]))).toBeNull();
  });
});
