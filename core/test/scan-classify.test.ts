import { describe, expect, it } from 'vitest';

import { componentCounts, looksLikeBundle, wantedFor } from '../src/scan/classify';
import * as fx from './fixtures';

// Every model number here is real: from a recorded Home Depot response in
// fixtures/recorded/ or from core/test/fixtures.ts.

describe('looksLikeBundle', () => {
  it.each([
    ['RYOBI', 'PBLRC2501SB'], ['RYOBI', 'PCL500525SB'], ['RYOBI', 'PBLRC01B-PBLRC25B'], ['RYOBI', 'PCL1600K2-A983002'],
    ['RYOBI', 'PBLRC2501SB-A13401'], ['RYOBI', 'PCL280B-RHMTS12601'], ['ryobi', 'pcl1201k2-pcl430b'],
    ['DEWALT', 'DCK200D1P1W921B'], ['DEWALT', 'DCK540D1WCS334B'], ['DEWALT', 'DCK200D1P1WB606'], ['DEWALT', 'DCK940D2W240-2'], ['DEWALT', 'DCKTS681D1P1W34'],
  ])('%s %s has the shape of a bundle', (brand, model) => expect(looksLikeBundle(brand, model)).toBe(true));

  it.each([
    ['RYOBI', 'PBLRC25B'], ['RYOBI', 'PCL1600K2'], ['RYOBI', 'PCL280K1'], ['RYOBI', 'PSBRC02K1'], ['RYOBI', 'PBLCK112K2'], ['RYOBI', 'PCLCK202K'],
    ['DEWALT', 'DCK240C2'], ['DEWALT', 'DCKTS681D1P1'], ['DEWALT', 'DCKO222M1'], ['DEWALT', 'DCK2101QQ2'], ['DEWALT', 'DCF891B'], ['DEWALT', 'DCB205-2'], ['DEWALT', 'DCF513EB'],
    ['Milwaukee', '3050-21-2446-20'],
  ])('%s %s is not a bundle', (brand, model) => expect(looksLikeBundle(brand, model)).toBe(false));

  it('agrees with the splitter on every real DEWALT bundle in the fixtures', () => {
    for (const [model] of fx.HD_DEWALT_BUNDLES) expect(looksLikeBundle('DEWALT', model)).toBe(true);
    expect(looksLikeBundle('DEWALT', fx.HD_DEWALT_AMBIGUOUS[0])).toBe(true);
  });
});

describe('wantedFor', () => {
  it('asks for a single tool, a kit, and a battery 2-pack', () => {
    expect(wantedFor('ryobi', ' pblrc25b ', fx.RYOBI_CATALOG)).toEqual({ brand: 'RYOBI', model: 'PBLRC25B' });
    expect(wantedFor('DEWALT', 'DCK940D2', fx.DEWALT_CATALOG)).toEqual({ brand: 'DEWALT', model: 'DCK940D2', isKit: true });
    expect(wantedFor('DEWALT', 'DCK200D1P1', new Map())).toEqual({ brand: 'DEWALT', model: 'DCK200D1P1', isKit: true });
    expect(wantedFor('DEWALT', 'DCB205-2', fx.DEWALT_CATALOG)).toEqual({ brand: 'DEWALT', model: 'DCB205-2', packQty: 2 });
    expect(wantedFor('DEWALT', 'DCB205', fx.DEWALT_CATALOG)).toEqual({ brand: 'DEWALT', model: 'DCB205' });
  });
});

describe('componentCounts', () => {
  it('counts repeated components', () => {
    expect(componentCounts(['DCB205', 'DCK283D2', 'DCB205'])).toEqual({ DCB205: 2, DCK283D2: 1 });
    expect(componentCounts([])).toEqual({});
  });
});
