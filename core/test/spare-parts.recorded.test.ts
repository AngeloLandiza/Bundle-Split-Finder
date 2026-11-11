import { describe, expect, it } from 'vitest';

import { type Candidate, grade, type Grade, pick } from '../src/match';
import { candidatesFor, listingFrom, modelsInTitle } from '../src/scan/listings';
import type { ListingRecord } from '../src/scan/types';
import { parseAmazonProduct, parseAmazonSearch } from '../src/serpapi/parsers';
import { RECORDED_NAMES, recorded, type RecordedName } from './recorded';

// Spare parts must not match as tools (Ruling 65). Every title here is a recorded Amazon row
// (fixtures/recorded/); nothing reaches the network. A title that clearly names a part that is not
// the tool is rejected as a "spare part"; one that only may be a part ("OEM" or "Replacement" alone)
// is review at most, so the owner decides.

const rows = (name: RecordedName): Candidate[] => parseAmazonSearch(recorded(name));
const row = (name: RecordedName, asin: string): Candidate => {
  const r = rows(name).find((c) => c.asin === asin);
  if (!r) throw new Error(`${asin} is not in ${name}`);
  return r;
};

describe('a title that clearly names a spare part is rejected', () => {
  // Every recorded row graded against a model it carries whose grade differs from the base (14f13f8),
  // and the brandless spare-part rows near them that keep their grade. A spare part is "OEM" with a
  // digit part number together with a part's name; "Replacement" with a part's name alone is review at most.
  it.each([
    // RYOBI brand and the model as a whole word: probable at the base.
    ['amazon-search-P553', 'B08TGP8MGR', 'P553', 'probable', 'reject', 'OEM 89240027010 Replacement Miter Saw Inlet Dust Chute P553 TS1144'],
    ['amazon-search-P553', 'B08TGW83LC', 'P553', 'probable', 'reject', 'OEM 089240026711 Replacement Miter Saw Bevel Lock Knob W/Washer P553 TS1144'],
    // No aftermarket word at all; it names three tools it fits.
    ['amazon-search-PCL430', 'B00DQD7EIE', 'PCL430', 'probable', 'reject', 'OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 MT100G NT1MT PSL1MT01'],
    ['amazon-search-PCL430', 'B00DQD7EIE', 'P343', 'probable', 'reject', 'OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 MT100G NT1MT PSL1MT01'],
    ['amazon-search-PCL430', 'B00DQD7EIE', 'P570', 'probable', 'reject', 'OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 MT100G NT1MT PSL1MT01'],
    // No brand, so review at the base; an OEM part number with the part's name makes them rejects.
    ['amazon-search-P553', 'B0HPPZBS5S', 'P553', 'review', 'reject', '#US Replace Tool Parts for Ryobi OEM 89240027010 Miter Saw Inlet Dust Chute P553 TS1144 - (dvuipart.191026.29529)'],
    ['amazon-search-PCL430', 'B0HPPVDLDG', 'PCL430', 'review', 'reject', '#US Replace Tool Parts for Ryobi OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 MT100G NT1MT - (dvuipart.191026.29630)'],
    ['amazon-search-PCL430', 'B0HPPVDLDG', 'P343', 'review', 'reject', '#US Replace Tool Parts for Ryobi OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 MT100G NT1MT - (dvuipart.191026.29630)'],
    ['amazon-search-PCL430', 'B0HPPVDLDG', 'P570', 'review', 'reject', '#US Replace Tool Parts for Ryobi OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 MT100G NT1MT - (dvuipart.191026.29630)'],
    // No brand and no OEM part number: "Replacement" with a part's name stays a question for the owner.
    ['amazon-search-P553', 'B0DXK73C59', 'P553', 'review', 'review', 'Replacement 89240027010 Miter Saw Inlet Dust Chute for Ryobi P553 TS1144'],
    ['amazon-search-P553', 'B0HDKCY9N2', 'P553', 'review', 'review', 'Replacement Miter Saw Inlet Dust Chute P553 TS1144 For Ryobi 89240027010'],
    ['amazon-search-P553', 'B0FJM7MT77', 'P553', 'review', 'review', 'Replacement Miter Saw Inlet Dust Chute for Ryobi P553 TS1144，Replaces Part # 89240027010'],
    ['amazon-search-P553', 'B0FJMCB1LJ', 'P553', 'review', 'review', 'Replacement Miter Saw Indicator Miter for Ryobi P553 TS1144，Replaces Part # 089240027099'],
    ['amazon-search-PCL430', 'B0D5Y8PQXJ', 'PCL430', 'review', 'review', 'for Ryobi 692512002 Sleeve Multi-Tool MT100 MT100G NT1MT P343 P570 PCL430, for ryobi Multi Tool Replacement Parts, 692512002, for ryobi pcl430 Sleeve, for ryobi Multi Tool Sleeve'],
    ['amazon-search-PCL430', 'B0BHXWV2K9', 'PCL430', 'review', 'review', 'Replacement 303590006 Sanding Pad for Ryobi MT100 NT1MT MT100G P570 P343 PCL430 NT1MT PSL1MT01'],
    ['amazon-search-PCL430', 'B0HDKJ3M2B', 'PCL430', 'review', 'review', 'Replacement Multi-Tool Sleeve MT100 MT100G NT1MT P343 P570 PCL430 For Ryobi 692512002'],
  ] as const)('%s %s for %s: %s at the base, %s now', (name, asin, model, _base, now, title) => {
    const c = row(name, asin);
    expect(c.title).toBe(title);
    const g = grade({ brand: 'RYOBI', model }, c);
    expect(g.grade).toBe(now);
    if (now === 'reject') expect(g.reasons).toEqual(['spare part']);
  });
});

describe('hand-made titles: a genuine listing that mentions a replacement or an OEM number is never rejected', () => {
  // Hand-made, not recorded: plausible genuine titles. Each carries the brand and the model, so
  // without the spare-part words it would be probable; with them it is review, never reject.
  it.each([
    ['RYOBI', 'PCL406B', 'RYOBI ONE+ 18V Cordless 5 in. Random Orbit Sander with 3 Replacement Sanding Pads PCL406B'],
    ['DEWALT', 'DCS438B', 'DEWALT 20V MAX XR Cut-Off Tool, Includes Replacement Cutting Wheels (DCS438B)'],
    ['RYOBI', 'P2080', 'RYOBI ONE+ 18V Cordless String Trimmer P2080 with Replacement Spool Cap'],
    ['RYOBI', 'P108', 'RYOBI OEM 130429028 ONE+ 18V Lithium-Ion Battery P108'],
  ] as const)('hand-made: %s %s "%s" is review', (brand, model, title) => {
    const g = grade({ brand, model }, { asin: 'HANDMADE', title, brand });
    expect(g).toMatchObject({ grade: 'review', reasons: ['brand and model number in the title, but the title may name a spare part (OEM or Replacement)'] });
  });

  it('hand-made: a barcode match is exact even on a title with an OEM part number and a part\'s name (B08TGW83LC\'s title)', () => {
    const c = { ...row('amazon-search-P553', 'B08TGW83LC'), upcs: ['033287193721'] };
    expect(grade({ brand: 'RYOBI', model: 'P553', upc: '033287193721' }, c).grade).toBe('exact');
    expect(grade({ brand: 'RYOBI', model: 'P553' }, c)).toMatchObject({ grade: 'reject', reasons: ['spare part'] });
  });

  it('hand-made: "Replacement" with a part\'s name and no OEM number is review on a RYOBI row (B00KB7LA0Q\'s title, one pack)', () => {
    const c = row('amazon-search-P553', 'B00KB7LA0Q');
    expect(c).toMatchObject({ brand: 'RYOBI', title: 'RY29550/RY30530 Trimmer (4 Pack) Replacement Storage Cap # 518019002-4pk' });
    const one = { ...c, title: 'RY29550/RY30530 Trimmer Replacement Storage Cap # 518019002' };
    expect(grade({ brand: 'RYOBI', model: 'RY29550' }, one).grade).toBe('review');
  });
});

describe('a title that may be a spare part is review, never probable', () => {
  // These recorded rows have no brand, so they are review already. Here each title is given the RYOBI
  // brand, as a detail page could: the title alone no longer makes it probable.
  it.each([
    ['amazon-search-PCL515', 'B0H6GHLQVD', 'PCL515'], // "OEM Blade Clamp Assembly for Ryobi P519 PCL515 …": "OEM" with no number after it
    ['amazon-search-PCL515', 'B0HCKTKG5Q', 'PCL515'], // "PCL515 Blade Holder For Ryobi & Hart Reciprocating Saw Replacement"
    ['amazon-search-PCL235', 'B0GJTLR3S7', 'PCL235'], // "Motor, Gearbox, Chuck, Brushes replacement parts for Ryobi PCL235 …"
  ] as const)('%s %s with a RYOBI brand is review for %s', (name, asin, model) => {
    const c = row(name, asin);
    expect(c.brand).toBeNull();
    expect(grade({ brand: 'RYOBI', model }, c).grade).toBe('review');
    expect(grade({ brand: 'RYOBI', model }, { ...c, brand: 'RYOBI' })).toMatchObject({
      grade: 'review', reasons: ['brand and model number in the title, but the title may name a spare part (OEM or Replacement)'],
    });
  });

  it('a part number or barcode match on a detail page is still strong or exact (the founder\'s ratchet with "OEM" in its title)', () => {
    const c = parseAmazonProduct(recorded('amazon-product-B0B3JWF5ZV'), 'B0B3JWF5ZV')!;
    const oem = { ...c, title: `OEM ${c.title}` };
    expect(grade({ brand: 'RYOBI', model: 'PBLRC25B' }, oem).grade).toBe('strong');
    expect(grade({ brand: 'RYOBI', model: 'PBLRC25B', upc: '033287193721' }, oem).grade).toBe('exact');
  });
});

describe('what a lookup chooses on the recordings', () => {
  it('P553: no listing is chosen; the miter saw\'s spare parts are not offered as it', () => {
    const picked = pick({ brand: 'RYOBI', model: 'P553' }, rows('amazon-search-P553'));
    expect(picked.chosen).toBeNull();
    expect(picked.review.map((g) => g.asin)).not.toContain('B08TGP8MGR');
    expect(picked.review.map((g) => g.asin)).not.toContain('B08TGW83LC');
  });

  it('PCL430: no listing is chosen; P343 in the same response is the multi-tool, not the backing pad', () => {
    expect(pick({ brand: 'RYOBI', model: 'PCL430' }, rows('amazon-search-PCL430')).chosen).toBeNull();
    expect(pick({ brand: 'RYOBI', model: 'P343' }, rows('amazon-search-PCL430')).chosen).toMatchObject({ asin: 'B0851MTW42', grade: 'probable' });
    expect(row('amazon-search-PCL430', 'B0851MTW42').title).toBe('P343 18V One+ Cordless Oscillating Multi-Tool (Bare tool)');
  });

  it('a part matched free from saved listings is graded the same way (candidatesFor, as the runner\'s pickFromListings)', () => {
    const saved = (['amazon-search-P553', 'amazon-search-PCL430'] as const)
      .flatMap((n) => rows(n).map((c) => listingFrom(c, ['RYOBI'], 0)))
      .filter((l): l is ListingRecord => l !== null);
    // The three spare parts carry the RYOBI brand, so they are saved and offered for these models.
    expect(candidatesFor('RYOBI', 'P553', saved).map((c) => c.asin)).toEqual(expect.arrayContaining(['B08TGP8MGR', 'B08TGW83LC']));
    expect(candidatesFor('RYOBI', 'PCL430', saved).map((c) => c.asin)).toContain('B00DQD7EIE');
    expect(pick({ brand: 'RYOBI', model: 'P553' }, candidatesFor('RYOBI', 'P553', saved)).chosen).toBeNull();
    expect(pick({ brand: 'RYOBI', model: 'PCL430' }, candidatesFor('RYOBI', 'PCL430', saved)).chosen).toBeNull();
    expect(pick({ brand: 'RYOBI', model: 'P343' }, candidatesFor('RYOBI', 'P343', saved)).chosen?.asin).toBe('B0851MTW42');
  });
});

describe('no genuine listing loses its grade', () => {
  /** Every recorded row against every model its title carries, and the model its search asked for. */
  function probableOrBetter(): string[] {
    const out = new Set<string>();
    const RANK: Record<Grade, number> = { exact: 0, strong: 1, probable: 2, review: 3, reject: 4 };
    for (const name of RECORDED_NAMES.filter((n) => n.startsWith('amazon-'))) {
      const asked = name.startsWith('amazon-search-') ? [name.slice('amazon-search-'.length)] : [];
      const cands = name.startsWith('amazon-product-')
        ? [parseAmazonProduct(recorded(name), name.slice('amazon-product-'.length))!]
        : rows(name);
      for (const c of cands) {
        for (const model of new Set([...asked, ...modelsInTitle('RYOBI', c.title), ...modelsInTitle('DEWALT', c.title)])) {
          const brand = model.startsWith('DC') ? 'DEWALT' : 'RYOBI';
          const isKit = model === 'PCL1600K2' || model === 'PCL1201K2' || model.startsWith('DCK');
          const g = grade({ brand, model, isKit }, c);
          if (RANK[g.grade] <= RANK.probable) out.add(`${name} ${c.asin} ${model} ${g.grade}`);
        }
      }
    }
    return [...out];
  }

  it('all 23 recordings are listed, 17 of them Amazon responses', () => {
    expect(RECORDED_NAMES).toHaveLength(23);
    expect(RECORDED_NAMES.filter((n) => n.startsWith('amazon-'))).toHaveLength(17);
  });

  /**
   * Ruling 70's only additions: a search that asked for a RYOBI model without its tool-only B, whose
   * RYOBI listing writes it with the B (PCL235B, PCL515B, PCL660B).
   */
  const TOOL_ONLY_B = [
    'amazon-search-PCL235 B0BGYFTPGK PCL235 probable',
    'amazon-search-PCL515 B0B88R7HWB PCL515 probable',
    'amazon-search-PCL660 B0B1GKJXNB PCL660 probable',
  ];

  it('219 listing and model pairs were probable or better before the rule; the 5 that are spare parts are gone and the other 214 keep their grade', () => {
    // The before-and-after table, row by row, is in the Task 2b report. The rule only rejects or
    // demotes, so a count of 214 means no genuine tool, battery, charger or kit listing lost its grade.
    // Ruling 70 then adds 3 pairs and changes none of the 214 (q1a report). Fix round 1 reads "2Pk" as a
    // pack of 2, which takes out one of the 214: B0CRSVC28P ("PCL660 2Pk - Bulk Packaged") for PCL660, a
    // non-retail 2-pack, now rejected. 216 now.
    const all = probableOrBetter();
    expect(all).toHaveLength(216);
    expect(all).toEqual(expect.arrayContaining(TOOL_ONLY_B));
    expect(all).not.toContain('amazon-search-PCL660 B0CRSVC28P PCL660 probable');
    const now = all.filter((k) => !TOOL_ONLY_B.includes(k));
    expect(now).toHaveLength(213);
    for (const asin of ['B08TGP8MGR', 'B08TGW83LC', 'B00DQD7EIE']) expect(now.some((k) => k.includes(` ${asin} `))).toBe(false);
    expect(now).toEqual(expect.arrayContaining([
      'amazon-search-PBLRC25B B0B3JWF5ZV PBLRC25B probable',
      'amazon-search-PBLRC01B B0B6Z2ZGVK PBLRC01B probable',
      'amazon-product-B0B3JWF5ZV B0B3JWF5ZV PBLRC25B strong',
      'amazon-product-B0B6Z2ZGVK B0B6Z2ZGVK PBLRC01B strong',
      'amazon-search-PCL430 B0851MTW42 P343 probable',
      'amazon-search-PBP002 B08L339D94 PBP002 probable',
      'amazon-search-PBP002 B09SV94MBQ PBP002 probable',
      'amazon-brand-ryobi-p1 B09G1WD2CG PBP005 probable',
      'amazon-search-PCL660 B0B1GKJXNB PCL660B probable',
    ]));
  });
});
