import { describe, expect, it } from 'vitest';

import { type Candidate, grade, modelForms, pick, sameModel, titleHasModel } from '../src/match';
import { candidatesFor, listingFrom } from '../src/scan/listings';
import type { ListingRecord } from '../src/scan/types';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { recorded, type RecordedName } from './recorded';

// Ruling 70: a RYOBI part written without its tool-only B (as a kit's Home Depot page writes it,
// "(1) PCL206 …") matches its Amazon listing, which writes the B (PCL206B). Every title here is a
// recorded Amazon row; nothing reaches the network.

const rows = (name: RecordedName): Candidate[] => parseAmazonSearch(recorded(name));
const row = (name: RecordedName, asin: string): Candidate => {
  const r = rows(name).find((c) => c.asin === asin);
  if (!r) throw new Error(`${asin} is not in ${name}`);
  return r;
};

describe('Ruling 70: the written forms of a model', () => {
  it('RYOBI: the model and its other form by one trailing B, as sameModel; DEWALT and a double B: the model only', () => {
    expect(modelForms('RYOBI', 'PCL206')).toEqual(['PCL206', 'PCL206B']);
    expect(modelForms('RYOBI', 'pcl206b')).toEqual(['PCL206B', 'PCL206']);
    expect(modelForms('RYOBI', 'PCL206BB')).toEqual(['PCL206BB']);
    expect(modelForms('DEWALT', 'DCF891')).toEqual(['DCF891']);
    for (const m of ['PCL206', 'PCL206B', 'PCL206BB', 'PBLRC25B']) {
      for (const f of modelForms('RYOBI', m)) expect(sameModel('RYOBI', f, m)).toBe(true);
    }
    expect(sameModel('RYOBI', 'PCL206BB', 'PCL206B')).toBe(false);
  });
});

describe('Ruling 70: a lookup\'s results, on the recordings', () => {
  it.each([
    ['amazon-search-PCL235', 'PCL235', 'B0BGYFTPGK'],
    ['amazon-search-PCL515', 'PCL515', 'B0B88R7HWB'],
    ['amazon-search-PCL660', 'PCL660', 'B0B1GKJXNB'],
  ] as const)('%s: %s is matched to its tool-only listing %s, probable', (name, model, asin) => {
    expect(titleHasModel('RYOBI', row(name, asin).title, `${model}B`)).toBe(true);
    expect(pick({ brand: 'RYOBI', model }, rows(name)).chosen).toMatchObject({ asin, grade: 'probable' });
  });

  it('PCL206: no listing; its search shows PCL206B only as renewed listings sold by "Amazon Renewed"', () => {
    expect(pick({ brand: 'RYOBI', model: 'PCL206' }, rows('amazon-search-PCL206')).chosen).toBeNull();
    for (const asin of ['B0BVYFSHXX', 'B0BKTNLS6X']) {
      const c = row('amazon-search-PCL206', asin);
      expect(c.brand).toBe('Amazon Renewed');
      expect(grade({ brand: 'RYOBI', model: 'PCL206' }, c)).toMatchObject({ grade: 'reject', reasons: ['different brand'] });
    }
  });

  it('P553 and PCL430: still no listing, and no review choice is a different model', () => {
    expect(pick({ brand: 'RYOBI', model: 'P553' }, rows('amazon-search-P553')).chosen).toBeNull();
    expect(pick({ brand: 'RYOBI', model: 'PCL430' }, rows('amazon-search-PCL430')).chosen).toBeNull();
  });

  it('only the B: a RYOBI P215 is not its P215BN listing (B09SN6Y6TS), and neither is a P215B', () => {
    const c = row('amazon-search-PCL206', 'B09SN6Y6TS');
    expect(c.title).toBe('ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only) P215BN');
    expect(grade({ brand: 'RYOBI', model: 'P215' }, c).grade).toBe('reject');
    expect(grade({ brand: 'RYOBI', model: 'P215B' }, c).grade).toBe('reject');
  });

  it('a title naming two tools is graded for either form as for the form it writes (B0FD253MKS)', () => {
    const vacuums = row('amazon-search-PCL430', 'B0FD253MKS');
    expect(vacuums.title).toBe('18V Cordless Hand Vacuums PCL700B & PCL702B (Tools Only)');
    for (const model of ['PCL700', 'PCL702']) {
      expect(grade({ brand: 'RYOBI', model }, vacuums)).toEqual(grade({ brand: 'RYOBI', model: `${model}B` }, vacuums));
    }
  });

  it('DEWALT is unchanged: a DCF891 is not the DCF891B listing B09YXXFPBJ', () => {
    const c = row('amazon-search-DCF891B', 'B09YXXFPBJ');
    expect(grade({ brand: 'DEWALT', model: 'DCF891B' }, c).grade).toBe('probable');
    expect(grade({ brand: 'DEWALT', model: 'DCF891' }, c)).toMatchObject({ grade: 'reject', reasons: ['no identifier matches'] });
  });

  it('the free path finds the same listings in the saved brand page (candidatesFor)', () => {
    const saved = rows('amazon-brand-ryobi-p1').map((c) => listingFrom(c, ['RYOBI'], 0)).filter((l): l is ListingRecord => l !== null);
    for (const [model, asin] of [['PCL235', 'B0BGYFTPGK'], ['PCL515', 'B0B88R7HWB'], ['PCL660', 'B0B1GKJXNB']] as const) {
      const cands = candidatesFor('RYOBI', model, saved);
      expect(cands.map((c) => c.asin)).toContain(asin);
      expect(pick({ brand: 'RYOBI', model }, cands).chosen).toMatchObject({ asin, grade: 'probable' });
    }
    expect(candidatesFor('DEWALT', 'PCL235', saved)).toEqual([]);
  });
});
