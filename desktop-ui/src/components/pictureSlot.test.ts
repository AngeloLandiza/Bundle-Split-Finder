// Nov 25: what a picture slot shows (components/Picture.tsx) and the inspector's large picture (screens/DealDetail.tsx).
// The addresses are real: Home Depot's from fixtures/recorded/hd-bundles-ryobi-p1.json, Amazon's from the store after six
// scans (fixtures/e2e-2026-11-23/after-scan6/scan/listings.json).
import { describe, expect, it } from 'vitest';

import type { DealPart } from '../api/types';
import { headPicture } from '../screens/DealDetail';
import { brandMark, pictureShown } from './Picture';

const HD = 'https://images.thdstatic.com/productImages/b16b4743-d4cf-4c84-b731-5ccd3e2cc507/svn/ryobi-power-tool-combo-kits-pcl1600k2-64_145.jpg';
const AMAZON = 'https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg';
const part = (model: string, image: string | null, hdImage: string | null = null) => ({ model, image, hdImage }) as unknown as DealPart;

describe('a picture slot', () => {
  it('shows a Home Depot or Amazon picture, and none when pictures are off or it failed', () => {
    expect(pictureShown(HD, { show: true, failed: false })).toBe(HD);
    expect(pictureShown(AMAZON, { show: true, failed: false })).toBe(AMAZON);
    expect(pictureShown(HD, { show: false, failed: false })).toBeNull();
    expect(pictureShown(HD, { show: true, failed: true })).toBeNull();
  });

  it('marks the empty square with the brand’s initial, never a guessed glyph', () => {
    expect(brandMark('DEWALT')).toBe('D');
    expect(brandMark('RYOBI')).toBe('R');
    expect(brandMark('Black & Decker')).toBe('BD');
    expect(brandMark('')).toBe('');
    expect(brandMark(null)).toBe('');
  });
});

describe('the inspector’s picture', () => {
  it('is the bundle’s own Home Depot photo, said as Home Depot’s', () => {
    expect(headPicture({ image: HD, model: 'PCL1600K2', parts: [part('PCL1600K2', AMAZON)] })).toEqual({ src: HD, label: 'PCL1600K2 on Home Depot' });
  });

  it('without one, the first part’s: its Amazon photo, else its own Home Depot photo', () => {
    expect(headPicture({ image: AMAZON, model: 'DCK240C2', parts: [part('DCD771', AMAZON)] })).toEqual({ src: AMAZON, label: 'DCD771 on Amazon' });
    expect(headPicture({ image: null, model: 'DCK240C2', parts: [part('DCD771', null, HD)] })).toEqual({ src: HD, label: 'DCD771 on Home Depot' });
    expect(headPicture({ image: null, model: 'DCK240C2', parts: [part('DCD771', null), part('DCF885', AMAZON)] }).src).toBeNull();
  });
});
