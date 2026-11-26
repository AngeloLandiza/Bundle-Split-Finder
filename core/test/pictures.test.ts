// Product pictures (core/src/links/pictures.ts): a stored address is shown only on the hosts the CSP names
// (agent/test/pictureCsp.test.ts checks the CSP). The addresses are real ones from fixtures/e2e-2026-11-23/after-scan6/scan/listings.json.
import { describe, expect, it } from 'vitest';

import { pictureUrl, rowPicture } from '../src/links/pictures';

const REAL = 'https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg';

describe('a stored picture', () => {
  it('is shown from the image host the stored listings hold', () => {
    expect(pictureUrl(REAL)).toBe(REAL);
  });

  it.each([
    ['none', null],
    ['empty', ''],
    ['plain http', 'http://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg'],
    ['another host', 'https://images-na.ssl-images-amazon.com/images/I/81XPDrUh9sL.jpg'],
    ['a lookalike', 'https://m.media-amazon.com.evil.example/images/I/x.jpg'],
    ['a user name', 'https://m.media-amazon.com@evil.example/x.jpg'],
    ['a port', 'https://m.media-amazon.com:444/images/I/x.jpg'],
    ['data', 'data:image/png;base64,iVBORw0KGgo='],
    ['javascript', 'javascript:alert(1)'],
    ['a space', 'https://m.media-amazon.com/images/I/a b.jpg'],
  ])('is not shown when it is %s', (_name, url) => expect(pictureUrl(url)).toBeNull());

  it('on a deal row is the first part’s, and only the first part’s', () => {
    expect(rowPicture([{ image: REAL }, { image: null }])).toBe(REAL);
    expect(rowPicture([{ image: null }, { image: REAL }])).toBeNull();
    expect(rowPicture([])).toBeNull();
  });
});
