import { describe, expect, it } from 'vitest';

import { type Candidate, grade, type Graded, modelForms, pick, sameModel, titleHasModel } from '../src/match';
import { candidatesFor, listingFrom } from '../src/scan/listings';
import { MATCH_CHOICES, matchQuestion, SPARE_PART_NOTE } from '../src/scan/runner';
import type { ListingRecord } from '../src/scan/types';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { recorded, type RecordedName } from './recorded';

// Ruling 70: a RYOBI part written without its tool-only B (as a kit's Home Depot page writes it,
// "(1) PCL206 …") matches its Amazon listing, which writes the B (PCL206B). Ruling 71: a match question
// offers at most five listings, best first. Every title here is a recorded Amazon row unless it says
// hand-made; nothing reaches the network.

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

  it('fix round 1: "2Pk" is a pack of 2, so B0CRSVC28P is not a single PCL660 or PCL660B', () => {
    const c = row('amazon-search-PCL660', 'B0CRSVC28P');
    expect(c.title).toBe('18V LED Light, PCL660 2Pk - Bulk Packaged, Handheld, Green, 2pk-PCL660=BT');
    for (const model of ['PCL660', 'PCL660B']) {
      expect(grade({ brand: 'RYOBI', model }, c)).toMatchObject({ grade: 'reject', reasons: ['pack of 2, component is a pack of 1'] });
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

describe('Ruling 71: a match question\'s listings', () => {
  it('P553: 22 listings, 5 shown, most reviews first, with the spare-part note and the cut count', () => {
    const cands = rows('amazon-search-P553');
    const { reason, listed } = matchQuestion(pick({ brand: 'RYOBI', model: 'P553' }, cands).review, cands, 7);
    expect(listed).toHaveLength(MATCH_CHOICES);
    expect(listed.map((c) => c.asin)).toEqual(['B0DXK73C59', 'B0GY3L2LFP', 'B0HP6GFW3H', 'B0HL81J9GN', 'B0HN1FZ74T']);
    // B0DXK73C59 is the only one with a review; the rest keep the response's order.
    expect(listed[0]).toMatchObject({ reviews: 1, title: 'Replacement 89240027010 Miter Saw Inlet Dust Chute for Ryobi P553 TS1144', seenAt: 7 });
    expect(reason).toBe(`22 listing(s) show the model number, but the brand is not confirmed; ${SPARE_PART_NOTE}; 17 more listing(s) not shown`);
  });

  it('PCL430: 8 listings, 5 shown; one shown says "Replacement Parts", so the note is there', () => {
    const cands = rows('amazon-search-PCL430');
    const { reason, listed } = matchQuestion(pick({ brand: 'RYOBI', model: 'PCL430' }, cands).review, cands, 0);
    expect(listed.map((c) => [c.asin, c.reviews])).toEqual([
      ['B0GWT6TBJ2', 2], ['B0D5Y8PQXJ', 2], ['B0HPF71CNF', null], ['B0HGFPX3MX', null], ['B0HKCWMCH4', null],
    ]);
    expect(listed[1]!.title).toContain('for ryobi Multi Tool Replacement Parts');
    expect(reason).toBe(`8 listing(s) show the model number, but the brand is not confirmed; ${SPARE_PART_NOTE}; 3 more listing(s) not shown`);
  });

  it('PCL235 before Ruling 70 (its tool-only listing aside): 2 listings, none cut, the note for "replacement parts"', () => {
    const cands = rows('amazon-search-PCL235').filter((c) => c.asin !== 'B0BGYFTPGK');
    const { reason, listed } = matchQuestion(pick({ brand: 'RYOBI', model: 'PCL235' }, cands).review, cands, 0);
    expect(listed.map((c) => c.asin)).toEqual(['B0HFS4PFLN', 'B0GJTLR3S7']);
    expect(reason).toBe(`2 listing(s) show the model number, but the brand is not confirmed; ${SPARE_PART_NOTE}`);
  });

  it('hand-made: grade first, then most reviews, then a listing with a price before one without', () => {
    const c = (asin: string, reviews: number | null, price: number | null): Candidate => ({ asin, title: `RYOBI P1 ${asin}`, reviews, price });
    const g = (asin: string, gr: Graded['grade'], reason: string): Graded => ({ asin, grade: gr, packaging: 'retail', reasons: [reason] });
    const cands = [c('A', 0, null), c('B', 0, 10), c('C', 5, null), c('D', 1, 3), c('E', 9, 9), c('F', 0, 1)];
    const review = [
      g('A', 'review', 'model number in the title, brand not confirmed'), g('B', 'review', 'model number in the title, brand not confirmed'),
      g('C', 'review', 'model number in the title, brand not confirmed'), g('D', 'review', 'model number in the title, brand not confirmed'),
      g('E', 'reject', 'hand-made worse grade'), g('F', 'probable', 'hand-made better grade'),
    ];
    const { reason, listed } = matchQuestion(review, cands, 0);
    expect(listed.map((x) => x.asin)).toEqual(['F', 'C', 'D', 'B', 'A']);
    expect(reason).toBe('4 listing(s) show the model number, but the brand is not confirmed; 1 more listing(s) not shown');
  });

  it('hand-made: five or fewer listings, none saying Replacement or OEM: the reason is as before', () => {
    const cands: Candidate[] = [{ asin: 'A', title: 'Gearcase for X P1' }, { asin: 'A', title: 'Gearcase for X P1' }];
    const review: Graded[] = [{ asin: 'A', grade: 'review', packaging: 'retail', reasons: ['model number in the title, brand not confirmed'] }];
    expect(matchQuestion(review, cands, 0)).toMatchObject({ reason: '1 listing(s) show the model number, but the brand is not confirmed' });
  });
});
