import { describe, expect, it } from 'vitest';

import { type Candidate, grade, isBulkPackaging } from '../src/match';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { recorded, type RecordedName } from './recorded';

// The PO (Nov 18): "some tools have listings named (bulk packaging) or state in the description that it
// is repackaged, so just look for listings that say New, no used or refurbished listings". A tool taken
// out of a kit comes loose, so a New listing in bulk or non-retail packaging is a place to sell it.
// Every title here is a recorded Amazon row unless it says otherwise; nothing reaches the network.

const rows = (name: RecordedName): Candidate[] => parseAmazonSearch(recorded(name));
const row = (name: RecordedName, asin: string): Candidate => {
  const r = rows(name).find((c) => c.asin === asin);
  if (!r) throw new Error(`${asin} is not in ${name}`);
  return r;
};

describe('one test for bulk or non-retail packaging', () => {
  it.each([
    // fixtures/recorded/
    'P102 18 Volt One Plus Compact Lithium Ion Battery Pack (Bulk Packaged)',
    '18-Volt 3/8 In. Drill/Driver - Bare Tool (P209DCN), Bulk Packaged',
    '18-Volt Ryobi Charger PCG002, (NO Retail Packaging, Bulk Packaged)',
    '18V LED Light, PCL660 2Pk - Bulk Packaged, Handheld, Green, 2pk-PCL660=BT',
    '18-Volt Cordless Reciprocating Saw Kit with Battery and Charger (No Retail Packaging, Bulk Packaged)',
    // fixtures/validation/responses/: the old test missed the hyphen in "No-Retail" and "Bulk Packed".
    '40-Volt 4 Ah High Capacity Combo Kit, No-Retail Packaging, OP4040 + OP401',
    'P192 18 Volt 4.0 Ah ONE+ Lithium-Ion LITHIUM+ HP High Capacity Compact Battery (Non-Retail Packaging)',
    'DCS566 20V Circular Saw, 20V Cordless Brushless 6.5"" Circular Saw (Bare Tool Only, Bulk Packed), Yellow',
    // The PO's own words, which no recorded title carries yet.
    'RYOBI ONE+ 18V Cordless Impact Driver PCL235B (Bulk Packaging)',
    'RYOBI ONE+ 18V Cordless Impact Driver PCL235B (Repackaged)',
    'RYOBI ONE+ 18V Cordless Impact Driver PCL235B (Bulk)',
  ])('says bulk: %s', (title) => {
    expect(isBulkPackaging(title)).toBe(true);
  });

  it.each([
    // Recorded retail rows.
    'ONEAND 18V Lithium-ION Charger PCG002',
    'P102 18V One+ Compact Lithium Ion Battery, 2 Pack',
    'PCL660B ONE+ 18V Cordless LED Flash Light (Tool Only)',
    'OEM 140106011 Charger P119 18V Li-ion Dual C in Genuine Factory Package',
    // "Bulk" as a quantity, which the pack rules read (MULTI), not as packaging. Hand-made: no recorded title has one.
    'Bulk Pack of 10 Jigsaw Blades',
    'Drill Bits Bulk 25-Pack',
    'Bulk Pack Impact Driver Bits',
  ])('does not say bulk: %s', (title) => {
    expect(isBulkPackaging(title)).toBe(false);
  });

  it('labels the grading, and the label is not a grade: the recorded bulk rows grade as their retail titles would', () => {
    const p102 = row('amazon-search-PBP002', 'B00S022L2A');
    const p209 = row('amazon-search-PCL206', 'B09S7MD89M');
    expect(grade({ brand: 'RYOBI', model: 'P102' }, p102)).toMatchObject({ grade: 'probable', packaging: 'bulk' });
    expect(grade({ brand: 'RYOBI', model: 'P209DCN' }, p209)).toMatchObject({ grade: 'probable', packaging: 'bulk' });
    // The same row with its packaging words taken out (hand-made) grades the same.
    expect(grade({ brand: 'RYOBI', model: 'P102' }, { ...p102, title: 'P102 18 Volt One Plus Compact Lithium Ion Battery Pack' }))
      .toMatchObject({ grade: 'probable', packaging: 'retail', reasons: grade({ brand: 'RYOBI', model: 'P102' }, p102).reasons });
  });

  it('a used, renewed, refurbished or open-box listing is still rejected, bulk or not (hand-made from a recorded row)', () => {
    const p102 = row('amazon-search-PBP002', 'B00S022L2A');
    for (const word of ['Renewed', 'Refurbished', 'Used', 'Open Box']) {
      expect(grade({ brand: 'RYOBI', model: 'P102' }, { ...p102, title: `${p102.title} (${word})` }).grade).toBe('reject');
    }
  });
});
