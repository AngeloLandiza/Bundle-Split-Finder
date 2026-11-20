// Home Depot's highlight lines are read as page bullets, before the descriptive ones (the owner's PO: the
// Includes lists are the source of parts, with no leftovers). A highlight "Includes:" item that joins two
// products ("18V ONE+ 5-1/2 in. Circular Saw and 18V ONE+ Jig Saw", page 328690510) is two items, each to be
// accounted for; an "and" with no product on one side ("1/4" and 3/8" Extended Reach Ratchets", "(20) Black
// Oxide Drill and Drive Bits") stays one item. A product the page names twice is one item, and its batteries
// are counted once. Real data throughout: research-2026-11-20.json, pages-2026-11-10.json, the validation
// pages of Nov 18 and the second real run's answers.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parsePageSections, parsePageState } from '../src/hdPage';
import { bundleIdentity, pageEntry } from '../src/research/ledger';
import { researchQuestion } from '../src/research/loop';
import type { HomeDepotPage, ResearchAnswer, ResearchLedgerEntry, ResearchModel, ResearchPart, ResearchTurn } from '../src/research/types';
import { includesItems, verifyResearch } from '../src/research/verify';
import { replayedTools, type ToolCallLog } from '../../scripts/research-tools';
import type { ResearchRunsFile } from '../../scripts/research-eval-cli';
import { pcl500525sbLedger, researchCase, rowLine } from './research-world';

const research = JSON.parse(readFileSync('fixtures/homedepot-pages/research-2026-11-20.json', 'utf8')) as { pages: Record<string, unknown> };
const pages1110 = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as { pages: { itemId: string; text: string }[] }).pages;
const validation = JSON.parse(readFileSync('fixtures/validation/pages-2026-11-18.json', 'utf8')) as { pages: Record<string, { bullets: string[] }> };

const HIGHLIGHT = 'Includes: 18V ONE+ 5-1/2 in. Circular Saw and 18V ONE+ Jig Saw';
const CIRC_HALF = '18V ONE+ 5-1/2 in. Circular Saw';
const JIG_HALF = '18V ONE+ Jig Saw';
const SIBLING = 'PCL500B-PCL525B';

const hdPage = (itemId: string, sections: NonNullable<ReturnType<typeof parsePageState>>): HomeDepotPage =>
  ({ sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: `https://www.homedepot.com/p/${itemId}`, sections });
const bulletEntry = (id: string, bullets: string[]): ResearchLedgerEntry =>
  ({ id, kind: 'stored', label: 'Home Depot page', url: null, lines: bullets.map((text) => ({ field: 'bullet' as const, text })), products: [], isBundle: true });
const names = (entries: ResearchLedgerEntry[], brand = 'RYOBI') => includesItems(brand, entries).map((i) => ({ name: i.name, qty: i.qty, lists: i.lists }));

/** The true answer, every Includes item quoted under its part: the bullet's items, the highlight's halves, the sibling listing (the tie). */
function trueParts(ledger: ResearchLedgerEntry[], jig = 'PCL525B', halves = true): ResearchPart[] {
  const sibling = { quote: rowLine(ledger, 'hd-search:1', SIBLING), sourceId: 'hd-search:1' };
  return [
    { model: 'PCL500B', qty: 1, quotes: [
      { quote: rowLine(ledger, 'hd-search:1', 'PCL500B'), sourceId: 'hd-search:1' }, { quote: '18V 5-1/2" Circular Saw', sourceId: 'bundle' },
      ...(halves ? [{ quote: CIRC_HALF, sourceId: 'hd-page:328690510' }] : []),
      { quote: '18T Carbide Tipped Blade', sourceId: 'bundle' }, { quote: '(2) Hex Wrenches', sourceId: 'bundle' }, sibling,
    ] },
    { model: jig, qty: 1, quotes: [
      { quote: rowLine(ledger, 'hd-search:2', jig), sourceId: 'hd-search:2' }, { quote: '18V Jig Saw', sourceId: 'bundle' },
      ...(halves ? [{ quote: JIG_HALF, sourceId: 'hd-page:328690510' }] : []),
      { quote: 'Non-Marring Shoe', sourceId: 'bundle' }, { quote: 'T-Shank Wood Cutting Blade', sourceId: 'bundle' }, sibling,
    ] },
  ];
}

const answer = (p: ResearchPart[]): ResearchAnswer => ({ quotes: [], parts: p, reason: 'x', decision: 'parts', choiceIndex: null });
const reasonsOf = (r: { status: string; reasons?: string[] }): string[] => (r.status === 'unverified' ? r.reasons! : []);

describe('the page parser reads the highlights, before the descriptive bullets', () => {
  it('328690510: the three highlights, then the seventeen descriptive bullets', () => {
    const got = parsePageState(research.pages['328690510'], '328690510')!;
    expect(got.bullets.slice(0, 3)).toEqual([
      'Tackle Any Cut and Every Project with the 2-Tool Combo Kit',
      HIGHLIGHT,
      'Over 300 ONE+ Products – All Work With Any RYOBI ONE+ 18V Battery',
    ]);
    expect(got.bullets[3]).toBe('Circular Saw: Fast, clean cuts with cut speed of 4,700 RPM');
    expect(got.bullets).toHaveLength(20);
  });

  it('341645081 has no highlights: its bullets are its descriptive bullets, as before', () => {
    const got = parsePageState(research.pages['341645081'], '341645081')!;
    const details = (research.pages['341645081'] as Record<string, { details: { highlights: unknown; descriptiveAttributes: { value: string }[] } }>)['base-catalog-341645081']!.details;
    expect(details.highlights).toBeNull();
    expect(got.bullets).toEqual(details.descriptiveAttributes.map((a) => a.value));
    expect(got.bullets[0]).toBe('Drill/Driver - Powerful motor provides up to 515 in./lbs. of torque');
  });
});

describe('an Includes item joining two products is two items', () => {
  it('328690510: the highlight\'s circular saw and jig saw are two items, on their own list before the bullet\'s', async () => {
    const { ledger } = await pcl500525sbLedger();
    const items = names(ledger.filter((e) => e.id === 'hd-page:328690510'));
    expect(items.slice(0, 2)).toEqual([{ name: CIRC_HALF, qty: 1, lists: [0] }, { name: JIG_HALF, qty: 1, lists: [0] }]);
    expect(items.slice(2).map((i) => i.name)).toEqual([
      '18V 5-1/2" Circular Saw', '18V Jig Saw', '18T Carbide Tipped Blade', 'Hex Wrenches', 'Non-Marring Shoe', 'T-Shank Wood Cutting Blade',
    ]);
  });

  it('the true answer, PCL500B + PCL525B with the sibling listing quoted, verifies with each half quoted under its part', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    expect(ledger.find((e) => e.id === 'hd-page:328690510')!.lines.some((l) => l.text === HIGHLIGHT)).toBe(true);
    const r = verifyResearch(answer(trueParts(ledger)), q, ledger, catalog);
    expect(reasonsOf(r)).toEqual([]);
    expect(r).toMatchObject({ status: 'verified', answer: { parts: ['PCL500B', 'PCL525B'] } });
  });

  it('the whole highlight quoted under both parts accounts for each half by the part of its kind', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    const p = trueParts(ledger, 'PCL525B', false).map((x) => ({ ...x, quotes: [...x.quotes, { quote: HIGHLIGHT, sourceId: 'hd-page:328690510' }] }));
    expect(reasonsOf(verifyResearch(answer(p), q, ledger, catalog))).toEqual([]);
  });

  it('with the halves not quoted, each is left over on its own', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    expect(reasonsOf(verifyResearch(answer(trueParts(ledger, 'PCL525B', false)), q, ledger, catalog))).toEqual([
      `"${CIRC_HALF}" on the bundle's Includes list is left over: no part accounts for it.`,
      `"${JIG_HALF}" on the bundle's Includes list is left over: no part accounts for it.`,
    ]);
  });

  it('the jig saw swapped for another RYOBI jig saw (PBLJS01B) stays unverified', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    const r = verifyResearch(answer(trueParts(ledger, 'PBLJS01B')), q, ledger, catalog);
    expect(r.status).toBe('unverified');
    expect(reasonsOf(r)).toContain('Several RYOBI jig saws fit "18V Jig Saw"; nothing ties PBLJS01B to this bundle.');
    expect(reasonsOf(r)).toContain(`Several RYOBI jig saws fit "${JIG_HALF}"; nothing ties PBLJS01B to this bundle.`);
  });
});

describe('an "and" without a product on each side stays one item', () => {
  it('328814689: "1/4" and 3/8" Extended Reach Ratchets" is one item (a size, not a product, before the "and")', () => {
    const sections = parsePageState(research.pages['328814689'], '328814689')!;
    const entry = pageEntry('hd-page:328814689', hdPage('328814689', sections), { brand: 'RYOBI', model: 'PBLRC2501SB', itemId: '328814689' }, '328814689');
    const items = names([entry]);
    expect(items[0]).toEqual({ name: '1/4" and 3/8" Extended Reach Ratchets', qty: 1, lists: [0] });
    expect(items.filter((i) => /^(1\/4"|3\/8" Extended)/.test(i.name))).toHaveLength(1);
  });

  it('345178397: "(20) Black Oxide Drill and Drive Bits" is one item: "Drive Bits" is no product, and twenty of the two would be a guess', () => {
    const items = names([bulletEntry('bundle', validation.pages['345178397']!.bullets)]);
    expect(items).toContainEqual({ name: 'Black Oxide Drill and Drive Bits', qty: 20, lists: [1] });
    expect(items.some((i) => i.name === 'Black Oxide Drill' || i.name === 'Drive Bits')).toBe(false);
  });
});

describe('a product the page names twice is one item', () => {
  it('a highlight that repeats a bullet\'s item is one item on both lists, and one quote of it does not span the two', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    // The Nov 20 highlight with its halves written as the page's Includes bullet writes them.
    const same = 'Includes: 18V 5-1/2" Circular Saw and 18V Jig Saw';
    const edited = ledger.map((e) => (e.id === 'hd-page:328690510' ? { ...e, lines: e.lines.map((l) => (l.text === HIGHLIGHT ? { ...l, text: same } : l)) } : e));
    const items = names(edited.filter((e) => e.id === 'hd-page:328690510'));
    expect(items.filter((i) => i.name === '18V Jig Saw')).toEqual([{ name: '18V Jig Saw', qty: 1, lists: [0, 1] }]);
    expect(items.filter((i) => i.name === '18V 5-1/2" Circular Saw')).toEqual([{ name: '18V 5-1/2" Circular Saw', qty: 1, lists: [0, 1] }]);
    const r = verifyResearch(answer(trueParts(edited, 'PCL525B', false)), q, edited, catalog);
    expect(reasonsOf(r)).toEqual([]);
  });

  it('PCL1600K2\'s own page names its two batteries twice ("2 Batteries", then PBP005 and PBP002): two, not four, against a title that counts two (320243671)', async () => {
    const RUN = JSON.parse(readFileSync('fixtures/research/runs-claude-opus-5-5-prompt2.json', 'utf8')) as ResearchRunsFile;
    const id = 'split:homedepot:320243671';
    const run = RUN.results.find((x) => x.questionId === id)!;
    const c = await researchCase(id);
    let i = 0;
    const model: ResearchModel = { provider: 'replay', model: RUN.model, send: async () => (run.turns as ResearchTurn[])[i++] ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } } };
    const s = await researchQuestion(c.q, c.evidence, replayedTools(run.tools as ToolCallLog[]), model, { catalog: c.catalog });
    expect(s.status).toBe('verified');
    const kit = pages1110.find((p) => p.itemId === '317987591')!;
    const sections = parsePageSections(kit.text, '317987591')!;
    expect(sections.bullets).toContain('Includes: 6 Tools, 2 Batteries, Charger, Bag, and Accessories');
    const ledger = [...s.research.ledger, pageEntry('hd-page:317987591', hdPage('317987591', sections), bundleIdentity(c.q), '317987591')];
    const r = verifyResearch(s.research.answer, c.q, ledger, c.catalog);
    expect(reasonsOf(r)).toEqual([]);
    expect(r).toMatchObject({ status: 'verified', answer: { parts: ['PCL1600K2', 'A986501'] } });
  });
});
