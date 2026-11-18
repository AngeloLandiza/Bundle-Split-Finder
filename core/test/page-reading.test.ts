// Step 6b, Rulings 75 and 76: a RYOBI special buy with two equal halves, and the reading a RYOBI
// page offers when the model number offers none.
import { describe, expect, it } from 'vitest';
import { type Catalog, decompose } from '../src/decompose';
import type { PageContent } from '../src/hdPage';
import { pageReadingOf, splitWithPage } from '../src/pageSplit';
import { splitChoices } from '../src/scan/answers';

const empty: Catalog = new Map();
const page = (bullets: string[]): PageContent => ({ bullets, description: null });

// Captured from Home Depot on Nov 17, 2026: item 339206615, PSK1212SB. The page writes
// "operator’s" with a curly apostrophe.
const PSK1212SB_TITLE = 'ONE+ 18V Lithium Starter Kit with (1) 2.0 Ah Battery, (1) 4.0 Ah Battery, and Charger';
const PSK1212SB_PAGE = page([
  'Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger, and operator’s manuals',
]);

// Captured from Home Depot on Nov 17, 2026: item 341644756, PCL1600K2-PBP003, its two Includes bullets.
const PCL1600K2_PBP003_PAGE = page([
  'Includes: (1) PCL206 18V ONE+ Cordless 1/2 in. Drill/Driver, (1) PCL235 18V ONE+ Cordless 1/4 in. Impact Driver, (1) PCL500 18V ONE+ Cordless 5-1/2 in. Circular Saw, (1) PCL515 Reciprocating Saw, (1) PCL430 Multi-Tool, (1) PCL660 18V ONE+ Cordless LED Light',
  "Includes: 18T Carbide Blade, Hex Wrench, Reciprocating Saw Blade, Hex Key, Flush Cut Blade, Plunge Cut Blade, 6 in. Wood Blade, Sanding Pad, 5-Pieces Sandpaper, (1) PBP005 18V 4.0 Ah Lithium Battery, (1) PBP002 18V 1.5 Ah Lithium Battery, (1) 18V Charger, Tool Bag, and Operator's Manuals",
]);

const split = (model: string, title: string, p: PageContent | null, known: Catalog = empty) =>
  splitWithPage({ brand: 'RYOBI', model, title }, decompose('RYOBI', model, title, known), p, known);

describe('Ruling 75: a RYOBI special buy whose two halves are equal is not a two-part special buy', () => {
  it('PSK1212SB offers no PSK12B reading and falls through to the later forms', () => {
    const got = decompose('RYOBI', 'PSK1212SB', PSK1212SB_TITLE, empty);
    expect((got.alternatives ?? []).some((r) => r.includes('PSK12B'))).toBe(false);
    expect(got).toEqual({ components: [], status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
  });

  it('PSK1212SB known as a kit resolves as one, as the later form reads it', () => {
    const kit: Catalog = new Map([['PSK1212SB', { model: 'PSK1212SB', brand: 'RYOBI', kinds: [], isKit: true }]]);
    expect(decompose('RYOBI', 'PSK1212SB', PSK1212SB_TITLE, kit)).toEqual({ components: ['PSK1212SB'], status: 'resolved', notes: ['manufacturer kit'] });
  });

  it('PBLRC2501SB, whose halves differ, still expands', () => {
    expect(decompose('RYOBI', 'PBLRC2501SB', '', empty).alternatives).toEqual([['PBLRC25B', 'PBLRC01B']]);
  });
});

describe("Ruling 76: a RYOBI page's Includes models, when the model number offers no reading", () => {
  it('PSK1212SB with its page: stays in review, offering the models as the page writes them, in page order', () => {
    expect(split('PSK1212SB', PSK1212SB_TITLE, PSK1212SB_PAGE)).toEqual({
      components: [], status: 'needs_review',
      notes: ['no known RYOBI bundle pattern', 'page names PBP004, PBP003, PCG002'],
      alternatives: [['PBP004', 'PBP003', 'PCG002']],
    });
  });

  it("PSK1212SB's question offers that one reading", () => {
    expect(splitChoices(split('PSK1212SB', PSK1212SB_TITLE, PSK1212SB_PAGE))).toEqual([['PBP004', 'PBP003', 'PCG002']]);
  });

  it('PSK1212SB with no page: no reading', () => {
    expect(split('PSK1212SB', PSK1212SB_TITLE, null).alternatives).toBeUndefined();
  });

  it('341644756 PCL1600K2-PBP003: the model number offers its reading, so the page adds none', () => {
    const modelSplit = decompose('RYOBI', 'PCL1600K2-PBP003', '', empty);
    const got = splitWithPage({ brand: 'RYOBI', model: 'PCL1600K2-PBP003', title: '' }, modelSplit, PCL1600K2_PBP003_PAGE, empty);
    expect(got.alternatives).toEqual([['PCL1600K2', 'PBP003']]);
    expect(got).toEqual(modelSplit);
  });

  // Hand-made (no captured page names the bundle's own model or a model twice): the bundle's own
  // model is dropped, a model named twice is offered once, and a bullet not starting "Includes" is not read.
  it('drops the bundle own model, names each model once, and reads only Includes bullets (hand-made)', () => {
    const got = split('PSK1212SB', '', page([
      'Includes: (1) PSK1212SB Starter Kit, (1) PBP004 Battery, (1) PCG002 Charger',
      'Works with the PBP007 and every 18V ONE+ battery',
      'Includes: (1) PBP004 Battery, (1) PBP003 Battery',
    ]));
    expect(got.alternatives).toEqual([['PBP004', 'PCG002', 'PBP003']]);
    expect(got.notes).toEqual(['no known RYOBI bundle pattern', 'page names PBP004, PCG002, PBP003']);
  });

  it('PSK1212SB catalogued as a kit resolves as a manufacturer kit before any page reading (fix round 1)', () => {
    const kit: Catalog = new Map([['PSK1212SB', { model: 'PSK1212SB', brand: 'RYOBI', kinds: [], isKit: true }]]);
    const got = split('PSK1212SB', PSK1212SB_TITLE, PSK1212SB_PAGE, kit);
    expect(got).toEqual({ components: ['PSK1212SB'], status: 'resolved', notes: ['manufacturer kit', 'page does not name PSK1212SB'] });
    expect(got.alternatives).toBeUndefined();
  });

  it('a page that names only the bundle own model offers nothing (hand-made)', () => {
    const got = split('PSK1212SB', '', page(['Includes: (1) PSK1212SB Starter Kit']));
    expect(got.alternatives).toBeUndefined();
    expect(got.status).toBe('needs_review');
  });
});

// Captured from Home Depot on Nov 17, 2026: item 320511079, its two Includes bullets ("(2) PBP005").
const PAGE_320511079 = page([
  'Includes: (1) PCL206 18V ONE+ 1/2 in. Drill/Driver, (1) PCL235 18V ONE+ 1/4 in. Impact Driver, (1) PCL515 18V ONE+ Reciprocating Saw, (1) PCL500 18V ONE+ 5-1/2 in. Circular Saw, (1) PCL430 18V ONE+ Multi-Tool, (1) PCL525 18V ONE+ Jig Saw, (1) PCL406 18V ONE+ Random Orbit Sander, (1) PCL660 18V ONE+ LED Light,',
  'Includes: (2) PBP005 18V ONE+ 4.0 Ah Lithium Batteries, (1) PBP002 18V ONE+ Compact Lithium Battery, (1) PCG002 18V ONE+ Charger, Reciprocating Saw Blade, Circular Saw Blade, Multi-Tool Accessories, Jig Saw Blade, Sandpaper Assortment, (2) Tool Bags and Operator’s Manuals',
]);

describe('Ruling 76, fix round 1: the page reading keeps the counts the page writes', () => {

  it("320511079's bullets under a special-buy model with equal halves (hand-labelled: PSK0505SB is not that bundle's model): PBP005 twice", () => {
    const got = split('PSK0505SB', '', PAGE_320511079);
    const reading = ['PCL206', 'PCL235', 'PCL515', 'PCL500', 'PCL430', 'PCL525', 'PCL406', 'PCL660', 'PBP005', 'PBP005', 'PBP002', 'PCG002'];
    expect(got).toEqual({
      components: [], status: 'needs_review',
      // The note names each model once; the reading keeps the repeat (fix round 2).
      notes: ['no known RYOBI bundle pattern', 'page names PCL206, PCL235, PCL515, PCL500, PCL430, PCL525, PCL406, PCL660, PBP005, PBP002, PCG002'],
      alternatives: [reading],
    });
    // The question offers it with the repeat: a part listed twice counts twice.
    expect(splitChoices(got)).toEqual([reading]);
  });

  // Hand-made: a model with no count, and a model named in two places at different counts.
  it('a model with no count appears once; one named in two places counts once, at the larger count (hand-made)', () => {
    const got = split('PSK1212SB', '', page([
      'Includes: (1) PBP004 Battery, PCG002 Charger',
      'Includes: (3) PBP004 Batteries and (1) PCG002 Charger',
    ]));
    expect(got.alternatives).toEqual([['PBP004', 'PBP004', 'PBP004', 'PCG002']]);
    expect(got.notes).toEqual(['no known RYOBI bundle pattern', 'page names PBP004, PCG002']);
  });

  // Hand-made (fix round 2): a count written before something that is not a model stays with it.
  it('a count on a non-model never carries to the next model (hand-made)', () => {
    expect(split('PSK1212SB', '', page(['Includes: (2) Hex Wrenches, PBP004'])).alternatives).toEqual([['PBP004']]);
  });

  // Hand-made (fix round 2): a count outside 1 to 9 before a model is not read as a quantity, and the
  // page then offers no reading at all; the split stays in review without one.
  it.each(['(0)', '(50)'])('a count of %s before a model: no reading (hand-made)', (count) => {
    const got = split('PSK1212SB', '', page([`Includes: ${count} PBP004 Batteries, (1) PCG002 Charger`]));
    expect(got).toEqual({ components: [], status: 'needs_review', notes: ['no known RYOBI bundle pattern'] });
  });

  it('a count outside 1 to 9 before a non-model does not stop the reading (hand-made)', () => {
    expect(split('PSK1212SB', '', page(['Includes: (1) PBP004 Battery, (20) Drive Bits'])).alternatives).toEqual([['PBP004']]);
  });
});

describe('Ruling 76, final fix round: a question whose reading came from the page is recognised by its note, exactly', () => {
  // The reason a review question carries is the split's notes joined by "; " (scan/runner.ts).
  const reasonOf = (got: { notes: string[] }) => got.notes.join('; ');

  it("PSK1212SB's runner reason is a page reading", () => {
    const got = split('PSK1212SB', PSK1212SB_TITLE, PSK1212SB_PAGE);
    expect(reasonOf(got)).toBe('no known RYOBI bundle pattern; page names PBP004, PBP003, PCG002');
    expect(pageReadingOf(reasonOf(got))).toBe(true);
  });

  it("the repeated-part case (item 320511079's bullets, PBP005 twice, named once in the note) is a page reading", () => {
    const got = split('PSK0505SB', '', PAGE_320511079);
    expect(got.notes[1]).toContain('PBP005, PBP002');
    expect(pageReadingOf(reasonOf(got))).toBe(true);
  });

  it('a single model named is a page reading too', () => {
    expect(pageReadingOf('no known RYOBI bundle pattern; page names PBP004')).toBe(true);
  });

  it('the other notes that begin "page names" are not', () => {
    expect(pageReadingOf('no known RYOBI bundle pattern; page names no models')).toBe(false);
    expect(pageReadingOf('model number says DCB205; page names DCB204, DCD791, which do not fit the model number')).toBe(false);
    expect(pageReadingOf('page names PBP004, which does not fit the model number')).toBe(false);
    expect(pageReadingOf('page does not name PBP004')).toBe(false);
  });

  it('a reason with no page note, or an empty one, is not', () => {
    expect(pageReadingOf('no known RYOBI bundle pattern')).toBe(false);
    expect(pageReadingOf("'ABC' fits PBP004 and PBP003")).toBe(false);
    expect(pageReadingOf('')).toBe(false);
  });

  it('a sentence that only contains the words is not', () => {
    expect(pageReadingOf('the page names PBP004')).toBe(false);
    expect(pageReadingOf('page names PBP004 and PBP003')).toBe(false);
  });
});
