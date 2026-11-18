import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BRAND_IN_TITLE_ONLY, BRAND_NOT_CONFIRMED, type Candidate, grade, KIT_NOT_KNOWN, NOT_INCLUDED, packNotKnown, pick,
} from '../src/match';
import { MATCH_CHOICES, matchQuestion } from '../src/scan/runner';
import { parseAmazonSearch } from '../src/serpapi/parsers';

// The four listings the validation run left unmatched (step 8b, listingsMissed), graded from the
// responses the run recorded (fixtures/validation/responses/) and labelled blind
// (fixtures/validation/labels-2026-11-18.json). Each now reaches the owner as a question; none is
// used without the owner's yes. The guards keep third-party, kit-variant and pack rows rejected.

const rows = (brand: string, q: string): Candidate[] =>
  parseAmazonSearch(JSON.parse(readFileSync(
    new URL(`../../fixtures/validation/responses/amazon/engine=amazon_k=${brand}_${q}.json`, import.meta.url), 'utf8',
  )).data);
const row = (brand: string, q: string, asin: string): Candidate => {
  const r = rows(brand, q).find((c) => c.asin === asin);
  if (!r) throw new Error(`${asin} is not in the ${brand} ${q} response`);
  return r;
};

describe('the listings the validation found missed reach the owner as review, never above', () => {
  it.each([
    // "Battery and Charger NOT Included" was read as a kit ("and charger").
    ['PCL265B', 'PCL265B', 'B0BL8BC8MF', 'Ryobi PCL265 18V ONE+ Cordless 1/2 in. Impact Wrench (Tool ONLY- Battery and Charger NOT Included)', NOT_INCLUDED],
    // "TTI Ryobi": TTI makes RYOBI; the brand field is empty.
    ['PBP004', 'PBP004', 'B09HDZ5MPV', 'TTI Ryobi PBP004 ONE+ High Performance 18 Volts Lithium-Ion 4.0 Ah Battery', BRAND_IN_TITLE_ONLY],
    // The part is itself a 65-piece accessory kit.
    ['A986501', 'A986501', 'B09KHGD84Q', 'Drill and Impact Drive KIT 65-Piece A986501', KIT_NOT_KNOWN],
    // The part is itself RYOBI's 2-pack.
    ['PBP2003', 'PBP2003', 'B0BG5SPWVL', 'ONEAND 18V HIGH Performance Lithium-ION 2.0 AH Compact Battery 2-Pack PBP2003', packNotKnown(2)],
  ])('%s: %s is review (%s)', (model, q, asin, title, reason) => {
    const c = row('RYOBI', q, asin);
    expect(c.title).toBe(title);
    const g = grade({ brand: 'RYOBI', model }, c);
    expect(g.grade).toBe('review');
    expect(g.reasons[0]).toBe(reason);
    // The lookup's pick: nothing is used, and the labelled listing is among those the owner is asked about.
    const cands = rows('RYOBI', q);
    const p = pick({ brand: 'RYOBI', model }, cands);
    expect(p.chosen).toBeNull();
    expect(p.review.map((r) => r.asin)).toContain(asin);
    // The match question shows it among its MATCH_CHOICES and says why it is a question.
    const { reason: why, listed } = matchQuestion(p.review, cands, 0);
    expect(listed.length).toBeLessThanOrEqual(MATCH_CHOICES);
    expect(listed.map((x) => x.asin)).toContain(asin);
    expect(why.split('; ')).toContain(reason);
  });

  it('PCL265B and PBP004 also appear in other recorded searches; graded the same there', () => {
    for (const q of ['PCL206', 'PCL1201K2']) expect(grade({ brand: 'RYOBI', model: 'PCL265B' }, row('RYOBI', q, 'B0BL8BC8MF')).grade).toBe('review');
    for (const q of ['PBP002', 'PBP003', 'PBP2003', 'PSK0114']) expect(grade({ brand: 'RYOBI', model: 'PBP004' }, row('RYOBI', q, 'B09HDZ5MPV')).grade).toBe('review');
  });

  it('"TTI Ryobi" states the brand but no more: the reason is not "brand not confirmed"', () => {
    const g = grade({ brand: 'RYOBI', model: 'PBP004' }, row('RYOBI', 'PBP004', 'B09HDZ5MPV'));
    expect(g.reasons).not.toContain(BRAND_NOT_CONFIRMED);
  });
});

describe('guards: what stays rejected', () => {
  it.each([
    // The five "Fits For RYOBI" rows that carry the exact Home Depot model (labels-report.md, item 5).
    ['A963001', 'A963001', 'B0F4K79GVT'],
    ['A989504', 'A989504', 'B0D7SXRCV7'],
    ['A971502', 'A971502', 'B0D7SW8F8L'],
    ['PCL235', 'PCL500', 'B0DND8RPJH'],
    ['PCL1201K2', 'PCL1600K2', 'B0D76ZFRJJ'],
  ])('"Fits For RYOBI": %s (in the %s search) stays an aftermarket reject', (model, q, asin) => {
    const want = { brand: 'RYOBI', model, isKit: model === 'PCL1201K2' };
    const g = grade(want, row('RYOBI', q, asin));
    expect(g.grade).toBe('reject');
    expect(g.reasons).toEqual(['aftermarket or compatible part']);
  });

  it.each([
    // Third-party packs and kits "for Ryobi": no brand, or the title says it is for the brand.
    ['P102', 'PBP2003', 'B0D97QX1HN', 'pack of 2, component is a pack of 1'],
    ['P197', 'PBP2003', 'B0GRVD35NW', 'pack of 2, component is a pack of 1'],
    // RYOBI kit variants of a single tool: each carries a battery or a charger.
    ['PCL001B', 'PCL265B', 'B0DY31QJ4Q', 'listing is a kit, component is a single item'],
    ['PCL540', 'PCL265B', 'B0DNNZ1W52', 'listing is a kit, component is a single item'],
  ])('%s from the %s search, %s, stays rejected', (model, q, asin, reason) => {
    const g = grade({ brand: 'RYOBI', model }, row('RYOBI', q, asin));
    expect(g.grade).toBe('reject');
    expect(g.reasons).toEqual([reason]);
  });

  it('a third-party title that says "for Ryobi" stays rejected even with a pack or a kit word', () => {
    // Hand-made from the recorded "2 Pack P197 Replace for RYOBI 18V Battery with P117 Charger Combo"
    // (B0GRVD35NW), given the brand field so only the "for Ryobi" test can reject it.
    const c: Candidate = { asin: 'X', title: 'RYOBI 2 Pack P197 Replace for RYOBI 18V Battery', brand: 'RYOBI' };
    expect(grade({ brand: 'RYOBI', model: 'P197' }, c).grade).toBe('reject');
    const k: Candidate = { asin: 'Y', title: 'RYOBI 3-Piece Filter Kit for Ryobi 18V ONE+ PCL700B', brand: 'RYOBI' };
    expect(grade({ brand: 'RYOBI', model: 'PCL700B' }, k).grade).toBe('reject');
  });

  it('a DEWALT pack stays rejected: its model number says its pack size (DCB205 against DCB205-2)', () => {
    const c: Candidate = { asin: 'B0CZ9XR2Z7', title: '20V MAX Lithium-Ion Battery 2-Pack, 5.0 Ah (DCB205-2c)', brand: 'DEWALT' };
    expect(grade({ brand: 'DEWALT', model: 'DCB205' }, c).grade).toBe('reject');
  });

  it('a DEWALT title that only says "Kit" stays rejected: its model number says whether it is a kit', () => {
    const c: Candidate = { asin: 'B07TXN4DHD', title: 'XTREME 12V MAX* Impact Driver Kit, 1/4-Inch (DCF801F2)', brand: 'DEWALT' };
    expect(grade({ brand: 'DEWALT', model: 'DCF801F2' }, c).grade).toBe('reject');
  });

  it('"not included" only clears the battery and charger it names: a kit word elsewhere still rejects', () => {
    const c: Candidate = { asin: 'Z', title: 'RYOBI PCL540 Cut-Out Tool Kit with Battery, Bag Not Included', brand: 'RYOBI' };
    expect(grade({ brand: 'RYOBI', model: 'PCL540' }, c).grade).toBe('reject');
  });
});
