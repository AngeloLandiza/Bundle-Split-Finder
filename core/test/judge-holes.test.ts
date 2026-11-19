// Fix round 2 of step 10, Task 2: the holes an adversarial review found in verifyJudgement, and the
// kit ruling. Each case is a recorded listing (fixtures/ebay/validation-2026-11-19.json) with its
// label (fixtures/ebay/labels.json), unless marked constructed. The judge's answers are written here;
// nothing calls a model.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EbayListing } from '../src/ebay/types';
import { judgeListingFromEbay } from '../src/judge/fromEbay';
import type { EvidenceClaim, JudgeInput, JudgeRaw } from '../src/judge/types';
import { kitBatteryCount, verifyJudgement } from '../src/judge/verify';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8'));
const EBAY: Record<string, { items: Record<string, EbayListing> }> = readJson('ebay/validation-2026-11-19.json').parts;
const HD: Record<string, { brand: string; model: string; matchedModel: string | null; title: string | null }> = readJson(
  'validation/hd-part-prices-2026-11-18.json',
).prices;
const LABELS: { itemId: string; model: string; verdict: string }[] = readJson('ebay/labels.json').labels;

/** A recorded listing for a validation part, built as the eval builds it. */
function input(model: string, itemId: string): JudgeInput {
  const listing = EBAY[model]?.items[itemId.startsWith('v1|') ? itemId : `v1|${itemId}|0`];
  if (!listing) throw new Error(`no recorded listing ${itemId} for ${model}`);
  const hd = HD[model]!;
  return {
    part: {
      brand: hd.brand,
      model,
      ...(hd.matchedModel && hd.matchedModel !== hd.model ? { twin: hd.matchedModel } : {}),
      ...(hd.title ? { title: hd.title } : {}),
    },
    listing: judgeListingFromEbay(listing),
  };
}

const labelOf = (model: string, id: string) => LABELS.find((l) => l.model === model && l.itemId === `v1|${id}|0`)?.verdict;

type Quote = [EvidenceClaim, string];

/** A clean match: every field says one New unit of exactly the product. */
const match = (quotes: Quote[], over: Partial<JudgeRaw> = {}): JudgeRaw => ({
  evidence: quotes.map(([claim, quote]) => ({ claim, quote })),
  contentsMatch: true,
  quantity: 1,
  condition: 'new',
  extras: [],
  missing: [],
  reason: 'Written for the test.',
  verdict: 'match',
  ...over,
});

/** The listing's title as identity and contents: the answer a careless or fooled judge gives. */
const titleMatch = (i: JudgeInput) => match([['identity', i.listing.title], ['contents', i.listing.title]]);

const downgrades = (raw: JudgeRaw, i: JudgeInput) => verifyJudgement(raw, i).downgrades.join(' ');

describe('ruling 1: a listing naming the exact kit model sells the kit', () => {
  it.each([
    ['DCK225D2', '860158654414'], // DEWALT 20V MAX ATOMIC Brushless 2-Tool Combo Kit w/2 Li-Ion Batteries DCK225D2
    ['DCK240C2', '800845491870'], // NEW Dewalt 20V Cordless Drill Driver/Impact Driver Combo Kit DCK240C2 (FREE S&H)
    ['DCK940D2', '146662936520'], // DeWalt DCK940D2 20v Cordless 9-Tool Combo Kit (E10042984)
    ['PCL1600K2', '316052694370'], // Ryobi ONE+ 18V Cordless 6-Tool Combo Set (PCL1600K2)
  ])('%s %s (labelled match) verifies from its title alone', (model, id) => {
    expect(labelOf(model, id)).toBe('match');
    const i = input(model, id);
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('match');
  });

  it('still needs contentsMatch true and nothing missing', () => {
    const i = input('DCK225D2', '860158654414');
    expect(verifyJudgement(match([['identity', i.listing.title], ['contents', i.listing.title]], { contentsMatch: null }), i).verdict).toBe(
      'unsure',
    );
    expect(verifyJudgement(match([['identity', i.listing.title], ['contents', i.listing.title]], { missing: ['charger'] }), i).verdict).toBe(
      'unsure',
    );
  });

  // Constructed: no recorded kit listing denies a piece. The part name is DCK225D2's real one.
  const kit = (title: string, descriptionText = ''): JudgeInput => ({
    part: { brand: 'DEWALT', model: 'DCK225D2', title: HD.DCK225D2!.title! },
    listing: { itemId: 'constructed', title, aspects: [], descriptionText, conditionId: '1000' },
  });

  it.each([
    ['DEWALT DCK225D2 ATOMIC 2-Tool Combo Kit, 2 Batteries, No Charger'],
    ['DEWALT DCK225D2 ATOMIC 2-Tool Combo Kit Tool Only'],
    ['DEWALT DCK225D2 ATOMIC Combo Kit Battery Only'],
  ])('a kit listing that denies a piece stays refused (constructed): %s', (title) => {
    const i = kit(title);
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
  });

  it('a kit listing whose description says the charger is not included stays refused (constructed)', () => {
    const i = kit('DEWALT DCK225D2 ATOMIC 2-Tool Combo Kit', 'Two batteries and the bag. Battery charger is not included.');
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
  });

  it('a tool "pulled from a DCK225D2 kit" does not stand for the kit (constructed)', () => {
    const i = kit('DEWALT DCF850 impact driver pulled from a DCK225D2 kit');
    expect(downgrades(titleMatch(i), i)).toMatch(/charger/);
  });

  it('PCL1600K2 147674091595 "w/ 1 Li-Ion Battery" (labelled unsure): the kit has two', () => {
    expect(labelOf('PCL1600K2', '147674091595')).toBe('unsure');
    const i = input('PCL1600K2', '147674091595');
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
    expect(downgrades(titleMatch(i), i)).toMatch(/1 battery; the part's name says 2/);
  });

  it('counts the batteries a kit name says', () => {
    expect(kitBatteryCount(HD.DCK240C2!.title!)).toBe(2); // (2) 20V 1.3Ah Batteries
    expect(kitBatteryCount(HD.PCL1600K2!.title!)).toBe(2); // Compact Battery, 4.0 Ah Battery
    expect(kitBatteryCount(HD.DCK316ST2M1!.title!)).toBe(3); // FLEXVOLT 6 Ah Battery, 20V 6 Ah and 4 Ah Batteries
    expect(kitBatteryCount(HD.PCL1800K3N!.title!)).toBe(3); // (1) Compact Battery and (2) 4.0 Ah Batteries
    expect(kitBatteryCount(HD.DCK200D1P1!.title!)).toBe(2); // 5.0 Ah and 2.0 Ah Batteries
    expect(kitBatteryCount(HD.PBP2003!.title!)).toBeNull(); // a battery, not a kit
  });
});

describe('ruling 2: the brand must be the part’s', () => {
  it('A986501 227605048699 (labelled unsure): its "65-Piece" count is not the problem, its brand is', () => {
    expect(labelOf('A986501', '227605048699')).toBe('unsure');
    const i = input('A986501', '227605048699');
    const said = downgrades(titleMatch(i), i);
    expect(said).not.toMatch(/65-piece/);
    expect(said).toMatch(/brand is given as "unbranded"/);
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
  });

  it.each([
    ['DCS391B', '116958216969', /unbranded/], // brand Unbranded on a DEWALT title
    ['DCF921B', '840092869695', /branded/], // brand BRANDED
    ['DCB205', '237159233078', /brand is given/], // a third-party battery
  ])('%s %s', (model, id, said) => {
    const i = input(model, id);
    expect(labelOf(model, id)).not.toBe('match');
    expect(downgrades(titleMatch(i), i)).toMatch(said);
  });

  it('TTI, RYOBI’s maker, is RYOBI’s brand (PCG002 327229233339, labelled match)', () => {
    const i = input('PCG002', '327229233339');
    const raw = match([['identity', 'TTI 18-Volt Ryobi Charger PCG002'], ['contents', 'Included components: Charger Only']]);
    expect(verifyJudgement(raw, i).verdict).toBe('match');
  });
});

describe('hole a: a quote cut short before a negation does not count', () => {
  it('PCL500B 147668297298: "the battery and charger" stops before "(which are not included)"', () => {
    const i = input('PCL500B', '147668297298');
    const raw = match([['identity', i.listing.title], ['contents', 'after getting the battery and charger']]);
    const v = verifyJudgement(raw, i);
    expect(v.verdict).toBe('unsure');
    expect(v.downgrades.join(' ')).toMatch(/stops before the listing says it is not included/);
    // The same listing with an honest contents quote is the labelled match it is.
    expect(labelOf('PCL500B', '147668297298')).toBe('match');
    expect(verifyJudgement(match([['identity', i.listing.title], ['contents', 'TOOL ONLY']]), i).verdict).toBe('match');
  });

  it('PCL235 960159882548: "Battery & Charger" stops before "NOT included"', () => {
    const i = input('PCL235', '960159882548');
    const raw = match([['identity', i.listing.title], ['contents', 'Battery & Charger']]);
    expect(downgrades(raw, i)).toMatch(/stops before/);
  });

  // Constructed kit listings: the part name is DCK225D2's real one.
  const kit = (descriptionText: string): JudgeInput => ({
    part: { brand: 'DEWALT', model: 'DCK225D2', title: HD.DCK225D2!.title! },
    listing: { itemId: 'constructed', title: 'DEWALT ATOMIC 2-Tool Combo Kit', aspects: [], descriptionText, conditionId: '1000' },
  });

  it.each([
    ['Includes 2 batteries, charger and bag are not included.', 'charger and bag'],
    ['Batteries, charger and bag are not included.', 'Batteries, charger and bag are not included.'],
    ['The battery and charger are sold seperately.', 'The battery and charger are sold seperately.'],
  ])('a negation after a list, or spelled "seperately", names nothing (constructed): %s', (descriptionText, quote) => {
    const i = kit(descriptionText);
    const raw = match([['identity', 'DEWALT ATOMIC 2-Tool Combo Kit'], ['contents', quote]]);
    expect(verifyJudgement(raw, i).verdict).toBe('unsure');
  });
});

describe('hole b: a pack suffix after a hyphen is another product', () => {
  // Constructed: no recorded title writes a model with a pack suffix. Part names are real.
  const listing = (title: string) => ({ itemId: 'constructed', title, aspects: [], descriptionText: '', conditionId: '1000' });

  it('DCB205-2 on a DCB205 part is a 2-pack', () => {
    const i: JudgeInput = { part: { brand: 'DEWALT', model: 'DCB205', title: HD.DCB205!.title! }, listing: listing('DEWALT DCB205-2 20V MAX 5.0Ah Battery') };
    expect(downgrades(titleMatch(i), i)).toMatch(/"dcb205-2", a pack form/);
  });

  it('PBP003-2 on a PBP003 part is a 2-pack', () => {
    const i: JudgeInput = { part: { brand: 'RYOBI', model: 'PBP003', title: HD.PBP003!.title! }, listing: listing('RYOBI PBP003-2 ONE+ 18V 2.0 Ah Battery') };
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
  });

  it('the part DCB203-2 is itself the 2-pack, so its own suffix and "2-Pack" stand', () => {
    const i: JudgeInput = {
      part: { brand: 'DEWALT', model: 'DCB203-2' },
      listing: listing('DEWALT DCB203-2 20V MAX Compact 2.0Ah Battery 2-Pack'),
    };
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('match');
  });
});

describe('hole c: accessory words after the model too', () => {
  it.each([
    ['DCB606', '820076505425'], // 12.0Ah Compatible with Dewalt 20V/60V Max Battery DCB606 …
    ['PCL206', '188845704613'], // Ryobi PCL206 Cordless Drill Motor Assembly
    ['PCL206', '227591262313'], // Ryobi PCL206 Cordless 1/2" Drill Motor full Assembly gearbox …
  ])('%s %s (labelled not_match)', (model, id) => {
    expect(labelOf(model, id)).toBe('not_match');
    const i = input(model, id);
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
  });

  it.each([
    ['RYOBI PCL206B Drill Driver Compatible with ONE+ batteries'],
    ['RYOBI PCL206B Replacement Drill for Ryobi kits'],
    ['RYOBI PCL206B drill, fits all ONE+ batteries'],
  ])('after the model (constructed): %s', (title) => {
    const i: JudgeInput = {
      part: { brand: 'RYOBI', model: 'PCL206B' },
      listing: { itemId: 'constructed', title, aspects: [], descriptionText: '', conditionId: '1000' },
    };
    expect(downgrades(titleMatch(i), i)).toMatch(/as accessories and compatible parts do/);
  });
});

describe('hole d: condition words in the title', () => {
  it.each([
    ['DCS391B', '117521722953', /open box/], // DEWALT 20V MAX DCS391B Circular Saw 6-1/2" Tool Only NEW Open Box
    ['PCL235', '800878614640', /open box/], // RYOBI ONE+ 18V 1/4" Cordless Impact Driver PCL235B NEW OPEN BOX
  ])('%s %s (labelled not_match): eBay says New, the title does not', (model, id, said) => {
    expect(labelOf(model, id)).toBe('not_match');
    const i = input(model, id);
    expect(i.listing.conditionId).toBe('1000');
    expect(downgrades(titleMatch(i), i)).toMatch(said);
  });

  it('"Brand New & Unused" is not "used" (PCL660 407347608384, labelled match)', () => {
    const i = input('PCL660', '407347608384');
    const raw = match([['identity', i.listing.title], ['contents', 'It is a "Bare Tool" Pulled from a Kit.']]);
    expect(verifyJudgement(raw, i).verdict).toBe('match');
  });

  it.each([['Untested'], ['Used'], ['Refurbished'], ['For Parts'], ['Parts Only'], ['AS IS']])('"%s" (constructed)', (word) => {
    const i: JudgeInput = {
      part: { brand: 'RYOBI', model: 'PCL206B' },
      listing: { itemId: 'constructed', title: `RYOBI PCL206B Drill Driver Tool Only ${word}`, aspects: [], descriptionText: '', conditionId: '1000' },
    };
    expect(verifyJudgement(titleMatch(i), i).verdict).toBe('unsure');
  });
});

describe('hole e: an MPN naming a different model of the family', () => {
  it.each([
    ['DCF921B', '407352842496', /DCF911B/], // MPN DCF911B under a DCF921B title
    ['DCF921B', '920101779170', /DCF911B/],
    ['DCS565B', '137797445056', /DCS391B/], // MPN DCS391B under a DCS565B title
  ])('%s %s (labelled unsure)', (model, id, said) => {
    expect(labelOf(model, id)).toBe('unsure');
    const i = input(model, id);
    expect(downgrades(titleMatch(i), i)).toMatch(said);
  });

  it('the part, its twin, or a kit-suffixed form does not lower it: PCL206 366607811264 (MPN PCL206K1, labelled match)', () => {
    expect(labelOf('PCL206', '366607811264')).toBe('match');
    const i = input('PCL206', '366607811264');
    expect(downgrades(titleMatch(i), i)).not.toMatch(/different model/);
  });
});

describe('cheap checks the labels asked for', () => {
  it.each([
    ['PCL235', '206708671407'], // RYOBI ONE+ 18V PCL235 1/4" Cordless Impact Driver & 1.5 Ah Battery
    ['PCL406', '227570592635'], // … Random Orbit Sander W/ Carry Bag NEW
    ['PCL430', '198655269487'], // … Multi-Tool PCL430B + 2 Battery Kit PSK1212SB
    ['PCG002', '157947182520'], // NEW Ryobi 18-Volt Cordless Compact Glue Gun with Battery and PCG002 Charger
    ['PCL660', '800780450566'], // Ryobi 18V LED Flashlight PCL660B w/ 18V Power Source P743 Bundle (Tool Only)
    ['PBP003', '336583587412'], // Ryobi PCL201K1 ONE+ 18V 3/8 in. Drill/Driver Kit, 2Ah PBP003 Battery, Charger
  ])('a title naming what the product does not include: %s %s', (model, id) => {
    expect(labelOf(model, id)).toBe('not_match');
    const i = input(model, id);
    expect(downgrades(titleMatch(i), i)).toMatch(/which the part's name does not include/);
  });

  it('"Cordless Battery Jigsaw" describes the tool (PCL525 128199455736, labelled match)', () => {
    expect(labelOf('PCL525', '128199455736')).toBe('match');
    const i = input('PCL525', '128199455736');
    expect(downgrades(titleMatch(i), i)).not.toMatch(/does not include/);
  });

  it('item specifics "Set Includes: …, Battery, Charger" on a tool-only product (PCL515B 318915722907, labelled unsure)', () => {
    expect(labelOf('PCL515B', '318915722907')).toBe('unsure');
    const i = input('PCL515B', '318915722907');
    expect(downgrades(titleMatch(i), i)).toMatch(/Set Includes/);
  });

  it('a multi-variation listing (P119 284198216434|585687063824, labelled not_match)', () => {
    const i = input('P119', 'v1|284198216434|585687063824');
    expect(downgrades(titleMatch(i), i)).toMatch(/several variations/);
  });
});
