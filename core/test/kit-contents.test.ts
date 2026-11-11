import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBundlePage, type PageContent } from '../src/hdPage';
import { kitContents, parseIncludes, type KitItem } from '../src/kitContents';
import { bundleKey, type BundleRecord } from '../src/scan/types';

interface Rec { itemId: string; status: number; text: string }
const pages = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: Rec[];
  }
).pages;

/** The bundle page of a recorded item, read with the page parser. */
const p = (id: string): PageContent => {
  const r = pages.find((x) => x.itemId === id);
  if (!r) throw new Error(`no recorded page ${id}`);
  const got = parseBundlePage(r.text, id);
  if (!got) throw new Error(`recorded page ${id} does not parse`);
  return got;
};

const models = (items: KitItem[]): string[] => items.flatMap((i) => (i.model ? [i.model] : []));
const PCL1600K2_MODELS = ['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL430', 'PCL660', 'PBP005', 'PBP002'];

describe('parseIncludes, on the recorded pages', () => {
  // The six tools of PCL1600K2, as both 317987591 and 341645081 write them (Bullet09).
  const PCL1600K2_TOOLS: KitItem[] = [
    { model: 'PCL206', name: 'PCL206 18V ONE+ Cordless 1/2 in. Drill/Driver', qty: 1 },
    { model: 'PCL235', name: 'PCL235 18V ONE+ Cordless 1/4 in. Impact Driver', qty: 1 },
    { model: 'PCL500', name: 'PCL500 18V ONE+ Cordless 5-1/2 in. Circular Saw', qty: 1 },
    { model: 'PCL515', name: 'PCL515 Reciprocating Saw', qty: 1 },
    { model: 'PCL430', name: 'PCL430 Multi-Tool', qty: 1 },
    { model: 'PCL660', name: 'PCL660 18V ONE+ Cordless LED Light', qty: 1 },
  ];
  const PCL1600K2_ACCESSORIES: KitItem[] = [
    { model: null, name: '18T Carbide Blade', qty: 1 },
    { model: null, name: 'Hex Wrench', qty: 1 },
    { model: null, name: 'Reciprocating Saw Blade', qty: 1 },
    { model: null, name: 'Hex Key', qty: 1 },
    { model: null, name: 'Flush Cut Blade', qty: 1 },
    { model: null, name: 'Plunge Cut Blade', qty: 1 },
    { model: null, name: '6 in. Wood Blade', qty: 1 },
    { model: null, name: 'Sanding Pad', qty: 1 },
    { model: null, name: '5-Pieces Sandpaper', qty: 1 },
  ];

  it('317987591, the plain kit PCL1600K2: the whole list in page order, each item once, no "and", no manual', () => {
    const got = parseIncludes('RYOBI', p('317987591').bullets);
    // This page writes "(1) 18V. Charger"; 341645081 writes "(1) 18V Charger". The name is the page's text.
    expect(got).toEqual([
      ...PCL1600K2_TOOLS,
      ...PCL1600K2_ACCESSORIES,
      { model: 'PBP005', name: 'PBP005 18V 4.0 Ah Lithium-Ion Battery', qty: 1 },
      { model: 'PBP002', name: 'PBP002 18V Compact Lithium-Ion Battery', qty: 1 },
      { model: null, name: '18V. Charger', qty: 1 },
      { model: null, name: 'Tool Bag', qty: 1 },
    ]);
    expect(models(got)).toEqual(PCL1600K2_MODELS);
    const names = got.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('341645081 (PCL1600K2-PBP004): the same models, and its charger as "18V Charger"', () => {
    const got = parseIncludes('RYOBI', p('341645081').bullets);
    expect(got).toEqual([
      ...PCL1600K2_TOOLS,
      ...PCL1600K2_ACCESSORIES,
      { model: 'PBP005', name: 'PBP005 18V 4.0 Ah Lithium Battery', qty: 1 },
      { model: 'PBP002', name: 'PBP002 18V 1.5 Ah Lithium Battery', qty: 1 },
      { model: null, name: '18V Charger', qty: 1 },
      { model: null, name: 'Tool Bag', qty: 1 },
    ]);
    expect(models(got)).toEqual(PCL1600K2_MODELS);
  });

  it('327939252 (PCL280B-PSK005): "Reversible 1/4 in. and 3/8 in. Anvil" stays one item; both manuals dropped', () => {
    expect(parseIncludes('RYOBI', p('327939252').bullets)).toEqual([
      { model: 'PCL280', name: 'PCL280 18V ONE+ Multi-Size Ratchet', qty: 1 },
      { model: null, name: 'Reversible 1/4 in. and 3/8 in. Anvil', qty: 1 },
      { model: null, name: '1/2 in. Anvil with 1/4 in. Hex', qty: 1 },
      { model: 'PBP006', name: 'PBP006 18V ONE+ Lithium 2.0 Ah battery', qty: 1 },
      { model: 'PCG002', name: 'PCG002 18V charger', qty: 1 },
    ]);
  });

  it('335849279 (PBLRC2501SB-A13401): the socket set is one item; its "- (1) 1/2 in., ..." sizes are not items', () => {
    expect(parseIncludes('RYOBI', p('335849279').bullets)).toEqual([
      { model: 'PBLRC01', name: 'PBLRC01 18V ONE+ HP Brushless 1/4" Extended Reach Ratchet', qty: 1 },
      { model: 'PBLRC25', name: 'PBLRC25 18V ONE+ HP Brushless Cordless 3/8 in. Extended Reach Ratchet', qty: 1 },
      { model: 'A13401', name: 'A13401 3/8 in. Deep well, thin wall socket', qty: 1 },
    ]);
  });

  it('a thousands comma does not split an item (hand-made bullet: no recording has one in an Includes list)', () => {
    expect(parseIncludes('RYOBI', ['Includes: (1) A981001 1,000-Piece Bit Set, Tool Bag, and Operator\'s Manual'])).toEqual([
      { model: 'A981001', name: 'A981001 1,000-Piece Bit Set', qty: 1 },
      { model: null, name: 'Tool Bag', qty: 1 },
    ]);
  });

  it('328814689 (PBLRC2501SB): PBLRC01 and PBLRC25, no comma between them, and the manual dropped', () => {
    expect(parseIncludes('RYOBI', p('328814689').bullets)).toEqual([
      { model: 'PBLRC01', name: 'PBLRC01 18V ONE+ HP Brushless 1/4" Extended Reach Ratchet', qty: 1 },
      { model: 'PBLRC25', name: 'PBLRC25 18V ONE+ HP Brushless Cordless 3/8 in. Extended Reach Ratchet', qty: 1 },
    ]);
  });

  it('328690510 (PCL500525SB): "(2) Hex Wrenches" is qty 2, and a tool with no model number is an unnamed item', () => {
    expect(parseIncludes('RYOBI', p('328690510').bullets)).toEqual([
      { model: null, name: '18V 5-1/2" Circular Saw', qty: 1 },
      { model: null, name: '18V Jig Saw', qty: 1 },
      { model: null, name: '18T Carbide Tipped Blade', qty: 1 },
      { model: null, name: 'Hex Wrenches', qty: 2 },
      { model: null, name: 'Non-Marring Shoe', qty: 1 },
      { model: null, name: 'T-Shank Wood Cutting Blade', qty: 1 },
    ]);
  });

  it('320683876: two lists joined by " : Includes:" read as two lists, each manual dropped (one with a curly apostrophe)', () => {
    expect(parseIncludes('RYOBI', p('320683876').bullets)).toEqual([
      { model: 'PBLRC25', name: 'PBLRC25 18V ONE+ HP Brushless Cordless 3/8 in. Extended Reach Ratchet', qty: 1 },
      { model: 'PBP004', name: 'PBP004 18V ONE+ 4.0 Ah Lithium Battery', qty: 1 },
    ]);
  });

  it('345178210: "Includes hex shank ..." with no colon is a feature line, not a list; the list names no model', () => {
    const got = parseIncludes('RYOBI', p('345178210').bullets);
    // This "6 Tools, 2 Batteries" list names no model, so kitContents never returns it.
    expect(models(got)).toEqual([]);
    expect(got.map((i) => i.name)).toEqual([
      '6 Tools', '2 Batteries', 'Charger', 'Bag', 'Accessories',
      'Magnetic Bit Holder', 'Hex Key', 'Countersink', 'Center Punch',
    ]);
  });

  it('320243741 (PCL1600K2-P553) has no Includes line and gives []', () => {
    expect(parseIncludes('RYOBI', p('320243741').bullets)).toEqual([]);
  });

  it('DEWALT 337440459 (DCK200D1P1W921B): its "<kit>: <tool>: text" bullets are not an Includes list, so []', () => {
    // No recorded DEWALT page carries an Includes bullet. The kit-and-tool prefixes name the tools
    // of DCK200D1P1 without its batteries or charger, and on another bundle's page: not contents.
    const bullets = p('337440459').bullets;
    expect(bullets[0]).toMatch(/^DCK200D1P1: DCD799: /);
    expect(parseIncludes('DEWALT', bullets)).toEqual([]);
    for (const id of ['337440461', '343992133', '343992132', '206510146']) {
      expect(parseIncludes('DEWALT', p(id).bullets)).toEqual([]);
    }
  });

  it('DEWALT models are read by the DEWALT model shape (hand-made bullet: no recording has a DEWALT Includes list)', () => {
    expect(parseIncludes('DEWALT', ['Includes: (2) DCB203 20V MAX 2.0Ah Batteries, DCB115 Charger, Kit Bag and Operators Manual'])).toEqual([
      { model: 'DCB203', name: 'DCB203 20V MAX 2.0Ah Batteries', qty: 2 },
      { model: 'DCB115', name: 'DCB115 Charger', qty: 1 },
      { model: null, name: 'Kit Bag', qty: 1 },
    ]);
  });
});

const reading = (id: string, readAt: number) => ({ ...p(id), readAt });

const record = (itemId: string, over: Partial<BundleRecord> = {}): BundleRecord => ({
  key: bundleKey(itemId),
  retailer: 'homedepot',
  itemId,
  title: 'RYOBI ONE+ 18V Cordless 6-Tool Combo Kit',
  brand: 'RYOBI',
  model: 'PCL1600K2',
  upc: null,
  price: 199,
  regularPrice: 299,
  percentOff: 33,
  link: null,
  seenAt: 1,
  split: null,
  ...over,
});

describe('kitContents', () => {
  it('is null when no stored record has that brand and model', () => {
    expect(kitContents([], 'RYOBI', 'PCL1600K2')).toBeNull();
    expect(kitContents([record('317987591', { page: reading('317987591', 1) })], 'DEWALT', 'PCL1600K2')).toBeNull();
    expect(kitContents([record('317987591', { page: reading('317987591', 1) })], 'RYOBI', 'PCL1201K2')).toBeNull();
  });

  it('is null when the record has no page, or a page with no model item', () => {
    expect(kitContents([record('317987591')], 'RYOBI', 'PCL1600K2')).toBeNull();
    expect(kitContents([record('317987591', { page: null })], 'RYOBI', 'PCL1600K2')).toBeNull();
    // A page with an Includes list that names no model (345178210's), stored under the kit's model.
    expect(kitContents([record('317987591', { page: reading('345178210', 1) })], 'RYOBI', 'PCL1600K2')).toBeNull();
    // A page with no Includes list at all.
    expect(kitContents([record('317987591', { page: reading('320243741', 1) })], 'RYOBI', 'PCL1600K2')).toBeNull();
  });

  it("returns the kit's own page's list", () => {
    const got = kitContents([record('317987591', { page: reading('317987591', 1) })], 'ryobi ', ' pcl1600k2');
    expect(got).toEqual(parseIncludes('RYOBI', p('317987591').bullets));
  });

  it("returns the newest page's list when two records match", () => {
    // Two stored records of one model under different item ids; the pages stand in for two readings.
    const a = (readAt: number) => record('317987591', { page: reading('317987591', readAt) });
    const b = (readAt: number) => record('999999999', { page: reading('328814689', readAt) });
    expect(models(kitContents([a(200), b(100)], 'RYOBI', 'PCL1600K2')!)).toEqual(PCL1600K2_MODELS);
    expect(models(kitContents([b(100), a(200)], 'RYOBI', 'PCL1600K2')!)).toEqual(PCL1600K2_MODELS);
    expect(models(kitContents([a(200), b(300)], 'RYOBI', 'PCL1600K2')!)).toEqual(['PBLRC01', 'PBLRC25']);
  });

  it('breaks a tie of readAt by itemId: the larger item id wins, whatever the order of the records', () => {
    const a = record('317987591', { page: reading('317987591', 100) });
    const b = record('999999999', { page: reading('328814689', 100) });
    expect(models(kitContents([a, b], 'RYOBI', 'PCL1600K2')!)).toEqual(['PBLRC01', 'PBLRC25']);
    expect(models(kitContents([b, a], 'RYOBI', 'PCL1600K2')!)).toEqual(['PBLRC01', 'PBLRC25']);
  });

  it('skips a newer page that names no model for an older one that does', () => {
    const named = record('317987591', { page: reading('317987591', 100) });
    const none = record('999999999', { page: reading('320243741', 200) });
    expect(models(kitContents([none, named], 'RYOBI', 'PCL1600K2')!)).toEqual(PCL1600K2_MODELS);
  });

  it('accepts the model with or without the tool-only B suffix', () => {
    const kit = record('317987591', { page: reading('317987591', 1) });
    expect(models(kitContents([kit], 'RYOBI', 'PCL1600K2')!)).toEqual(PCL1600K2_MODELS);
    expect(models(kitContents([kit], 'RYOBI', 'PCL1600K2B')!)).toEqual(PCL1600K2_MODELS);
    const storedWithB = record('317987591', { model: 'PCL1600K2B', page: reading('317987591', 1) });
    expect(models(kitContents([storedWithB], 'RYOBI', 'PCL1600K2')!)).toEqual(PCL1600K2_MODELS);
    // Only one B: PCL1600K2BB is another model.
    expect(kitContents([storedWithB], 'RYOBI', 'PCL1600K2BB')).toBeNull();
  });

  it("never reads the asking bundle's own page", () => {
    // 341645081 is PCL1600K2-PBP004: its page lists PCL1600K2's items, but it is not PCL1600K2's page.
    const bundle = record('341645081', { model: 'PCL1600K2-PBP004', page: reading('341645081', 1) });
    expect(kitContents([bundle], 'RYOBI', 'PCL1600K2')).toBeNull();
    const kit = record('317987591', { page: reading('317987591', 1) });
    expect(kitContents([bundle, kit], 'RYOBI', 'PCL1600K2')).toEqual(parseIncludes('RYOBI', p('317987591').bullets));
  });
});
