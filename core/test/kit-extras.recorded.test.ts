import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BRAND_NOT_CONFIRMED, type Candidate, grade, isReviewCap, KIT_WITH_EXTRAS, pick } from '../src/match';
import { wantedFor } from '../src/scan/classify';
import { modelsInTitle } from '../src/scan/listings';
import { matchQuestion } from '../src/scan/runner';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { RECORDED_NAMES, recorded } from './recorded';

// A part that is itself a kit (DEWALT DCK240C2, a drill and impact driver kit), and Amazon listings that
// sell the kit with more: a circular saw, a 40-piece screw driving set, a mechanics tool set. Rows from the
// validation run's recorded responses (fixtures/validation/responses/); labels from the blind check of
// Nov 18 (fixtures/validation/labels-2026-11-18.json, fixtures/audit/corpus.json): a bundle of the part
// with other items is not the part. Such a listing is review at most, never used without the owner's yes.

const VALIDATION = new URL('../../fixtures/validation/responses/amazon/', import.meta.url);
const rows = (file: string): Candidate[] => parseAmazonSearch(JSON.parse(readFileSync(new URL(file, VALIDATION), 'utf8')).data);
// The one recorded response that holds all four DCK240C2 rows.
const DCK316 = 'engine=amazon_k=DEWALT_DCK316ST2M1.json';
const row = (asin: string): Candidate => {
  const r = rows(DCK316).find((c) => c.asin === asin);
  if (!r) throw new Error(`${asin} is not in ${DCK316}`);
  return r;
};
const KIT = wantedFor('DEWALT', 'DCK240C2', new Map());

const EXTRAS = [
  ['B0722GYTWL', 'DCK240C2 20v Lithium Drill Driver/Impact Combo Kit (1.3Ah) with 20V MAX Circular Saw'],
  ['B072B8GHHL', 'DCK240C2 20v Lithium Drill Driver/Impact Combo Kit (1.3Ah) with FlexTorq Screw Driving Set, 40-Piece'],
  ['B08P6NCHMW', 'Mechanics Tool Set, Drill/Driver & Impact Driver Combo Kit (DCK240C2)'],
] as const;

describe('a kit part: a listing that sells the kit with more is review, never above', () => {
  it('DCK240C2 is asked for as a kit', () => {
    expect(KIT).toEqual({ brand: 'DEWALT', model: 'DCK240C2', isKit: true });
  });

  it.each(EXTRAS)('%s "%s" is review, with its reason', (asin, title) => {
    const c = row(asin);
    expect(c.title).toBe(title);
    expect(c.brand).toBe('DEWALT');
    const g = grade(KIT, c);
    expect(g.grade).toBe('review');
    expect(g.reasons[0]).toBe(KIT_WITH_EXTRAS);
    expect(isReviewCap(KIT_WITH_EXTRAS)).toBe(true);
  });

  it('the kit itself, B00IJ0ALYS, stays probable, and the lookup chooses it', () => {
    const c = row('B00IJ0ALYS');
    expect(c.title).toBe('20V MAX Cordless Drill and Impact Driver (DCK240C2)');
    expect(grade(KIT, c).grade).toBe('probable');
    const p = pick(KIT, rows(DCK316));
    expect(p.chosen?.asin).toBe('B00IJ0ALYS');
    expect(p.review.map((r) => r.asin)).toEqual(expect.arrayContaining(EXTRAS.map(([a]) => a)));
  });

  it('with only the bundles in a search, nothing is used and the owner is asked, with the reason', () => {
    const only = rows(DCK316).filter((c) => EXTRAS.some(([a]) => a === c.asin));
    const p = pick(KIT, only);
    expect(p.chosen).toBeNull();
    const { reason } = matchQuestion(p.review, only, 0);
    expect(reason.split('; ')).toContain(KIT_WITH_EXTRAS);
  });

  it('every recorded response grades the three the same way', () => {
    for (const file of readdirSync(VALIDATION)) {
      for (const c of rows(file).filter((x) => EXTRAS.some(([a]) => a === x.asin))) expect(grade(KIT, c).grade, `${file} ${c.asin}`).toBe('review');
    }
  });

  it('a single-item part treats these listings as before: a kit, rejected', () => {
    for (const [asin] of EXTRAS) {
      expect(grade({ brand: 'DEWALT', model: 'DCK240C2' }, row(asin))).toMatchObject({ grade: 'reject', reasons: ['listing is a kit, component is a single item'] });
    }
  });
});

describe('guards: a kit\'s own title keeps its grade', () => {
  /** Every recorded Amazon row (fixtures/recorded, fixtures/validation) against every kit model its title carries. */
  function kitRows(): { where: string; model: string; brand: string; c: Candidate }[] {
    const out: { where: string; model: string; brand: string; c: Candidate }[] = [];
    const add = (where: string, cands: Candidate[]) => {
      for (const c of cands) {
        for (const brand of ['DEWALT', 'RYOBI']) {
          for (const model of modelsInTitle(brand, c.title).filter((m) => /^(DCK|PCL\d+K|P\d+K)/.test(m))) out.push({ where, model, brand, c });
        }
      }
    };
    for (const name of RECORDED_NAMES.filter((n) => n.startsWith('amazon-search-') || n.startsWith('amazon-brand-'))) add(name, parseAmazonSearch(recorded(name)));
    for (const file of readdirSync(VALIDATION)) add(file, rows(file));
    return out;
  }

  it('on all recordings, the only kit rows the rule moves are the three bundles', () => {
    const touched = kitRows().filter(({ brand, model, c }) => grade({ brand, model, isKit: true }, c).reasons.includes(KIT_WITH_EXTRAS));
    // B0FK5VMQCY "3-Piece Filter Replacement Kit for Ryobi 18V ONE+ PCL700B PCL700K", graded here as if
    // PCL700K were a kit: no brand field, so it was review already and stays review.
    expect(new Set(touched.map((m) => m.c.asin))).toEqual(new Set([...EXTRAS.map(([a]) => a), 'B0FK5VMQCY']));
    for (const { brand, model, c } of touched.filter((m) => m.c.asin === 'B0FK5VMQCY')) {
      expect(grade({ brand, model, isKit: true }, c)).toMatchObject({ grade: 'review', reasons: [KIT_WITH_EXTRAS, BRAND_NOT_CONFIRMED] });
    }
  });

  it.each([
    // Recorded: the title names the kit's own tools after "with" (nothing named before it).
    ['DCK2100P2', 'FLEXVOLT ADVANTAGE 20V MAX* Combo Kit with Hammer Drill & Impact Driver, 5.0-Ah, 2-Tool (DCK2100P2)'],
    // Recorded: tools, then "with" batteries and a charger, which a kit holds.
    ['DCK2112QQ2', '20V MAX XR Brushless Hammer Drill 1/2 in. and High Torque 1/4 Impact Driver Combo with 2 x 4 Ah Batteries and 4 Amp Charger (DCK2112QQ2)'],
    // Recorded: a set of tools, counted, powered or multi, is the kit.
    ['DCK1021D2', '20V MAX Power Tool Combo Kit, 10 Tool Cordless Power Tool Set, 2 Batteries, Charger and 2 Bags Included, Dewalt Brushless Combo Kit (DCK1021D2)'],
    ['DCK300P1', '20V MAX Power Tool Combo Kit, Cordless Woodworking 3-Tool Set with 5ah Battery and Charger (DCK300P1)'],
    ['DCK202P1', '20V MAX Orbital Sander and Oscillating Tool, Cordless Woodworking 2-Tool Set with 5ah Battery and Charger (DCK202P1)'],
    ['DCK551D1M1', 'Tools 5 Tool Power Tool Combo Kit, Cordless Drill Impact Driver Saw Oscillating Multi-tool Set with 20V MAX Battery and Charger (DCK551D1M1)'],
    ['DCK921P1', '20V MAX 5Ah, Brushless 9 Power Tools with Battery, Charger, Drill, Impact Driver, Reciprocating Saw, Circular Saw, Oscillating Tool, Grinder, Orbit Sander, Impact Wrench, Flashlight (DCK921P1)'],
    // Hand-made: RYOBI's "ONE+" is not a "+" addition.
    ['P215K', 'RYOBI ONE+ 18V Cordless 1/2 in. Drill/Driver Kit with (1) 1.5 Ah Battery and Charger P215K'],
    // Hand-made (fix round 1): the part's own model after "with" is not an added model.
    ['DCK240C2', 'DEWALT 20V MAX Drill and Impact Driver Kit with Battery, Charger and Bag (DCK240C2)'],
    // Hand-made from recorded wording: "Extra Long Run Time" (B079LDT7ML, DCB230C) adds nothing, and
    // "ONE + (PLUS)" (B0781B4R4C) is RYOBI's ONE+ written out, not two joining words.
    ['DCK240C2', 'DEWALT 20V MAX Drill and Impact Driver Kit with Battery, Charger, Extra Long Run Time (DCK240C2)'],
    ['P215K', 'RYOBI ONE + (PLUS) 18V Cordless Drill/Driver Kit with 1.5 Ah Battery and Charger P215K'],
  ])('%s: "%s" stays probable', (model, title) => {
    const brand = model.startsWith('DC') ? 'DEWALT' : 'RYOBI';
    expect(grade({ brand, model, isKit: true }, { asin: 'G', title, brand }).grade).toBe('probable');
  });

  it.each([
    // Hand-made: the same additions written with "+", "plus" or "bundle".
    'DEWALT 20V MAX Drill/Driver & Impact Driver Combo Kit (DCK240C2) + 20V MAX Circular Saw',
    'DEWALT 20V MAX Drill and Impact Driver Kit (DCK240C2) plus Reciprocating Saw',
    'DEWALT 20V MAX Drill and Impact Driver Combo Kit (DCK240C2) Bundle with Oscillating Tool',
    'DEWALT 20V MAX Drill and Impact Driver Combo Kit (DCK240C2) and 100-Piece Bit Set',
    // Fix round 1. Tool words are whole words: "Lightweight" does not name a light, so the light is added.
    'DEWALT DCK240C2 Lightweight Drill and Impact Driver Kit with LED Work Light',
    // Every joining word is read, not only the first.
    'DEWALT 20V MAX Combo Kit with 2 Batteries plus Circular Saw (DCK240C2)',
    // A battery named by its model after a joining word, and an "extra" one.
    'DEWALT 20V MAX Drill and Impact Driver Kit (DCK240C2) with 5Ah Battery DCB205',
    'DEWALT DCK240C2 Combo Kit with Extra 5Ah Battery DCB205',
    // An accessory count written as Home Depot does: "70PC", "70 PC".
    'DEWALT 20V MAX Drill and Impact Driver Combo Kit (DCK240C2) and 70PC Drill Bit Kit',
    'DEWALT 20V MAX Drill and Impact Driver Combo Kit (DCK240C2) and 70 PC Accessories',
  ])('hand-made: "%s" is review', (title) => {
    const g = grade(KIT, { asin: 'H', title, brand: 'DEWALT' });
    expect(g.grade).toBe('review');
    expect(g.reasons[0]).toBe(KIT_WITH_EXTRAS);
  });

  it('hand-made, a known gap: "&", "and" and a comma are not read as additions (kits list their own tools that way)', () => {
    // Recorded, the reason: DCK2100P2 names its own tools after "with", joined by "&".
    const own = 'FLEXVOLT ADVANTAGE 20V MAX* Combo Kit with Hammer Drill & Impact Driver, 5.0-Ah, 2-Tool (DCK2100P2)';
    expect(grade({ brand: 'DEWALT', model: 'DCK2100P2', isKit: true }, { asin: 'G', title: own, brand: 'DEWALT' }).grade).toBe('probable');
    // Hand-made, the cost: a saw added with "&" is not seen (docs/decisions.md names this gap).
    const gap = 'DEWALT 20V MAX Drill and Impact Driver Combo Kit (DCK240C2) & 20V MAX Circular Saw';
    expect(grade(KIT, { asin: 'H', title: gap, brand: 'DEWALT' }).grade).toBe('probable');
  });

  it('a barcode match is the listing itself, whatever its title says', () => {
    const c: Candidate = { ...row('B0722GYTWL'), upcs: ['885911000000'] };
    expect(grade({ ...KIT, upc: '885911000000' }, c).grade).toBe('exact');
  });
});
