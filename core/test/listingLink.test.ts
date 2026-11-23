import { describe, expect, it } from 'vitest';
import { parseListingLink } from '../src/scan/listingLink';

describe('parseListingLink', () => {
  it('reads an eBay item id from /itm/<id>, /itm/<slug>/<id> and ?item=, whatever tracking rides along', () => {
    expect(parseListingLink('https://www.ebay.com/itm/237179711800')).toEqual({ site: 'ebay', id: '237179711800' });
    expect(parseListingLink('https://www.ebay.com/itm/DEWALT-DCF887B-20V-MAX-Impact-Driver/237179711800?hash=item3752abc&_trksid=p2332490&mkcid=1&campid=5338')).toEqual({ site: 'ebay', id: '237179711800' });
    expect(parseListingLink('https://m.ebay.com/itm/237179711800?mkevt=1')).toEqual({ site: 'ebay', id: '237179711800' });
    expect(parseListingLink('https://www.ebay.com/itm/?item=237179711800&ssPageName=STRK')).toEqual({ site: 'ebay', id: '237179711800' });
    expect(parseListingLink('https://www.ebay.com/itm/Some-Tool/237179711800#viTabs_0')).toEqual({ site: 'ebay', id: '237179711800' });
  });
  it('is eBay with no id for an eBay page that names no item', () => {
    expect(parseListingLink('https://www.ebay.com/sch/i.html?_nkw=dcf887b')).toEqual({ site: 'ebay' });
    expect(parseListingLink('https://www.ebay.com/itm/abc')).toEqual({ site: 'ebay' });
  });
  it('reads an Amazon ASIN from /dp/, /gp/product/ and the mobile path, with or without a title slug', () => {
    expect(parseListingLink('https://www.amazon.com/dp/B0BSJ97BSR')).toEqual({ site: 'amazon', id: 'B0BSJ97BSR' });
    expect(parseListingLink('https://www.amazon.com/RYOBI-Random-Orbit-Sander/dp/B0BSJ97BSR/ref=sr_1_3?crid=XYZ&keywords=ryobi&tag=x-20')).toEqual({ site: 'amazon', id: 'B0BSJ97BSR' });
    expect(parseListingLink('https://www.amazon.com/gp/product/b0bsj97bsr?th=1')).toEqual({ site: 'amazon', id: 'B0BSJ97BSR' });
    expect(parseListingLink('https://www.amazon.com/gp/aw/d/B0BSJ97BSR')).toEqual({ site: 'amazon', id: 'B0BSJ97BSR' });
    expect(parseListingLink('https://smile.amazon.com/dp/B0BSJ97BSR')).toEqual({ site: 'amazon', id: 'B0BSJ97BSR' });
  });
  it('is Amazon with no id for a search or an unreadable ASIN', () => {
    expect(parseListingLink('https://www.amazon.com/s?k=dcf887b')).toEqual({ site: 'amazon' });
    expect(parseListingLink('https://www.amazon.com/dp/short')).toEqual({ site: 'amazon' });
  });
  it('reads a Home Depot item id from /p/<slug>/<9 digits>, with its tracking', () => {
    expect(parseListingLink('https://www.homedepot.com/p/DEWALT-20V-MAX-Impact-Driver-DCF887B/328690510')).toEqual({ site: 'homedepot', id: '328690510' });
    expect(parseListingLink('https://www.homedepot.com/p/328690510?mtc=Shopping&cm_mmc=x')).toEqual({ site: 'homedepot', id: '328690510' });
    expect(parseListingLink('https://www.homedepot.com/b/Tools/N-5yc1vZc298')).toEqual({ site: 'homedepot' });
    expect(parseListingLink('https://www.homedepot.com/p/Some-Kit/12345')).toEqual({ site: 'homedepot' });
  });
  it('is other for every other site, a lookalike host, and anything that is not a web link', () => {
    expect(parseListingLink('https://www.facebook.com/marketplace/item/1234567890123')).toEqual({ site: 'other' });
    expect(parseListingLink('https://www.lowes.com/pd/DEWALT/5013345')).toEqual({ site: 'other' });
    expect(parseListingLink('https://notebay.com/itm/237179711800')).toEqual({ site: 'other' });
    expect(parseListingLink('https://ebay.com.evil.example/itm/237179711800')).toEqual({ site: 'other' });
    expect(parseListingLink('ftp://www.ebay.com/itm/237179711800')).toEqual({ site: 'other' });
    expect(parseListingLink('https://user:pw@www.ebay.com/itm/237179711800')).toEqual({ site: 'other' });
    expect(parseListingLink('just some words')).toEqual({ site: 'other' });
    expect(parseListingLink('')).toEqual({ site: 'other' });
  });
});
