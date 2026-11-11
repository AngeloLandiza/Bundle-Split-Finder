import { describe, expect, it } from 'vitest';
import { amazonListingUrl, amazonSearchUrl } from './links';

describe('amazonListingUrl', () => {
  it('points at the listing page', () => {
    expect(amazonListingUrl('B0CXYZ1234')).toBe('https://www.amazon.com/dp/B0CXYZ1234');
  });
});

describe('amazonSearchUrl', () => {
  it('searches brand and model together', () => {
    expect(amazonSearchUrl('DEWALT', 'DCB205')).toBe('https://www.amazon.com/s?k=DEWALT%20DCB205');
  });
  it('encodes a model with a slash or a space', () => {
    expect(amazonSearchUrl('RYOBI', 'P1/8 X')).toBe('https://www.amazon.com/s?k=RYOBI%20P1%2F8%20X');
  });
});
