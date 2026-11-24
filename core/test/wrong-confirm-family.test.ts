import { describe, expect, it } from 'vitest';

import { checkListingFields, listingProblem } from '../src/keepa/listingFields';
import { checkIdentity } from '../src/keepa/verify';
import { checkListingJudge } from '../src/listingJudge';
import { FAMILY_PATTERNS, grade, MODEL_PATTERNS, otherModelNamed } from '../src/match';
import { familyForms, measureFamilyOnJudge, measureFamilyOnPartNumbers, measureFamilyRule, wrongExample } from '../../scripts/measure-wrong-confirm';

// The wrong confirmation the owner caught (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json): Amazon's record for a
// "DWST60122-1 Dewalt Pro Backpack x McLaren F1 Team" carries brand DEWALT and part number DWST08017, the TOUGHSYSTEM
// adaptor plate a Home Depot set holds. No network.

const ex = wrongExample();

describe('a title that names another model of the brand family holds a confirmation', () => {
  it('the catalog check (rung 0) no longer confirms B0DGLWKS9S for DWST08017, and says why', () => {
    expect(checkIdentity(ex.want, ex.listing)).toEqual({ status: 'unknown', reason: 'its title names DWST60122-1, not DWST08017' });
    // Before the rule: the DC-only pattern saw no model in the title, and the record's part number confirmed it.
    expect(checkIdentity(ex.want, ex.listing, { family: false }).status).toBe('confirmed');
  });

  it('rung 1 and the listing judge (rung 3) hold it too', () => {
    expect(checkListingFields(ex.want, ex.listing)).toMatchObject({ status: 'unknown', rule: null, reason: 'its title names DWST60122-1, not DWST08017' });
    // Rung 3's contradiction check is rung 1's (listingProblem); its own quote check never read a DW model as one.
    expect(listingProblem(ex.want, ex.listing)).toBe('its title names DWST60122-1, not DWST08017');
    expect(listingProblem(ex.want, ex.listing, { family: false })).toBeNull();
    const raw = { quotes: [{ about: 'model_number' as const, field: 'part_number' as const, quote: 'DWST08017' }, { about: 'brand' as const, field: 'brand' as const, quote: 'DEWALT' }], reason: 'same', verdict: 'same' as const };
    expect(checkListingJudge(ex.want, ex.listing, raw).status).toBe('cannot_tell');
  });

  it('the part number grade (a lookup row or a Verify page with the part number) is a question, not strong', () => {
    const cand = { asin: ex.listing.asin, title: ex.listing.title!, brand: 'DEWALT', partNumber: 'DWST08017' };
    expect(grade(ex.want, cand)).toMatchObject({ grade: 'review', reasons: ['its title names DWST60122-1, not DWST08017', 'manufacturer part number match'] });
  });

  it('the wanted model named in the title clears it as before (B0CHWF4JM9, recorded in after-scan5)', () => {
    const right = { ...ex.listing, asin: 'B0CHWF4JM9', title: 'DWST08017 Tough System 2.0 Adapter, Toolbox, Connected, Stacked Storage, Outdoors' };
    expect(checkIdentity(ex.want, right)).toEqual({ status: 'confirmed', reason: "Amazon's catalog lists brand DEWALT, part number DWST08017" });
    expect(grade(ex.want, { asin: right.asin, title: right.title, brand: 'DEWALT', partNumber: 'DWST08017' }).grade).toBe('strong');
    // A title naming the part's model beside another of the family still clears it, as with MODEL_PATTERNS.
    expect(otherModelNamed('DEWALT', 'DWST08017', 'DWST08017 Adapter for DWST08450 and DWST17807')).toBeNull();
  });

  it('the family forms are the recorded ones; MODEL_PATTERNS stay as they were', () => {
    expect(MODEL_PATTERNS.DEWALT!.source).toBe('(?<![A-Z0-9])DC[A-Z]{1,3}[0-9]{3,4}[A-Z0-9]*(?:-[0-9])?(?![A-Z0-9])');
    const forms = familyForms();
    for (const f of ['DWST08017', 'DWMT74195', 'DWHT16148', 'DW0100', 'DW08302CG', 'DWAMF1235RL', 'DWST83342-1']) expect(forms.DEWALT!.has(f)).toBe(true);
    for (const f of ['A98401', 'A967001', 'A10FB1G', 'A90FS01A', 'RHSDM3501', 'FVD50K', 'STM312']) expect(forms.RYOBI!.has(f)).toBe(true);
    expect(otherModelNamed('DEWALT', 'DWST08017', ex.listing.title!)).toBe('DWST60122-1');
    expect(otherModelNamed('DEWALT', 'DWST08017', ex.listing.title!, MODEL_PATTERNS)).toBeNull();
    expect(otherModelNamed('RYOBI', 'A98401', 'RYOBI A986501 65-Piece Drill and Drive Kit')).toBe('A986501');
    // Not model numbers: a light bulb's A19, a 2-digit code, a bare "DW".
    for (const t of ['A19 LED bulb', 'A32 kit', 'DW 20V', 'DW12 bits']) expect(otherModelNamed('RYOBI', 'P102', t) ?? otherModelNamed('DEWALT', 'DCB205', t)).toBeNull();
    expect(Object.keys(FAMILY_PATTERNS)).toEqual(Object.keys(MODEL_PATTERNS));
  });

  it('measured: every answer key, one listing changed (the example, rightly held), no right listing lost, no wrong confirmation', () => {
    const f = measureFamilyRule();
    expect(f.rows).toBeGreaterThan(600);
    expect(f.changed.map((c) => `${c.label}: ${c.before} -> ${c.after}`)).toEqual(["B0DGLWKS9S for DWST08017 (the owner's example): confirmed -> unknown"]);
    expect([f.right, f.lost, f.unknown, f.wrong]).toEqual([1, 0, 0, 0]);
    // The part number grade: the example, and two listings whose key is uncertain (each title names another model).
    expect(measureFamilyOnPartNumbers().changed.map((c) => [c.label, c.key])).toEqual([
      ['B0DY31QJ4Q for PCL001K', 'uncertain'], ['B09SN6Y6TS for P215', 'uncertain'], ['B0DGLWKS9S for DWST08017', 'not'],
    ]);
    const j = measureFamilyOnJudge();
    expect([j.changedRecorded.length, j.worstWrongAfter, j.worstLost.filter((r) => r.key === 'is').length]).toEqual([0, 0, 0]);
  });
});
