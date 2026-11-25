// Nov 25, questions round 2 (docs/decisions.md): the 13 questions the Nov 24 rules left on the owner's data
// (fixtures/e2e-2026-11-23/after-scan6), and what Home Depot's own records settle of them: F a special buy Home Depot also
// sells under the same title as the tools its model number spells (PCL406424SB is PCL424B-PCL406B); G a DEWALT "<kit>W<two
// digits>" whose page names exactly one model ending in those digits (DCKTS681D1P1W82: DCS382B). The DCK225D2 bundles stay
// questions, now saying how Home Depot's two pages disagree, with both. Real records throughout.

import { describe, expect, it } from 'vitest';

import { join } from 'node:path';

import { loadScanFolder } from '../../scripts/data-folder';
import { briefForQuestion } from '../src/brief/view';
import { rejudgePackQuestions, withdrawUnreadSplitQuestions } from '../src/scan/runner';
import { pageCode, specialBuyTools } from '../src/scan/settle';
import { knownModels, readSplit } from '../src/scan/split';
import { DEFAULT_SCAN_SETTINGS } from '../src/scan/types';

const AFTER_SCAN6 = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const NOW = 1795600000000;
const store6 = () => loadScanFolder(AFTER_SCAN6);
const bundleOf = async (store: Awaited<ReturnType<typeof store6>>, itemId: string) => (await store.getBundle(`homedepot:${itemId}`))!;

describe('the 13 questions left after the Nov 24 rules, judged again at the start with no scan and nothing spent', () => {
  it('8 stay; 5 are settled (the four special-buy questions and DCKTS681D1P1W82)', async () => {
    const store = await store6();
    const openNow = async () => (await store.listReview()).filter((r) => r.answer === null).map((r) => r.model).sort();
    // Before: the Nov 24 rules alone leave 13 (core/test/fewer-questions.test.ts).
    await withdrawUnreadSplitQuestions(store, NOW, ['special_buy_twin', 'page_code']);
    await rejudgePackQuestions(store, DEFAULT_SCAN_SETTINGS, () => NOW);
    expect(await openNow()).toHaveLength(13);
    // After: the same store judged again with rules F and G, no scan, nothing spent.
    const settled = await withdrawUnreadSplitQuestions(store, NOW + 1);
    expect(settled.sort()).toEqual(['split:homedepot:325746670', 'split:homedepot:328690517', 'split:homedepot:328690521', 'split:homedepot:335723975', 'split:homedepot:335724135']);
    const open = await openNow();
    expect(open).toEqual([
      'DCK225D2WCS354B', 'DCK225D2WCS356B', 'DCK225D2WCS380B', 'DCK225D2WCS391B', 'DCKTS681D1P1W21', 'DWST08017',
      'PCL1600K2-A965201', 'PCL1600K2-A986501',
    ]);
    const split = async (itemId: string) => (await bundleOf(store, itemId)).split!;
    expect(await split('328690517')).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL416B'] });
    expect(await split('328690521')).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL424B'] });
    expect(await split('335723975')).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL416B', 'A21701', 'A21C901'] });
    expect(await split('335724135')).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL424B', 'A21701', 'A25RS51'] });
    expect(await split('325746670')).toMatchObject({ status: 'resolved', components: ['DCKTS681D1P1', 'DCS382B'] });
    // Judged again, nothing changes.
    expect(await withdrawUnreadSplitQuestions(store, NOW + 2)).toEqual([]);
  });
});

describe('rule F: a special buy Home Depot also sells as its tools under the same title', () => {
  it('PCL406424SB: the same title as PCL424B-PCL406B, each tool sold by itself, its kind in the title', async () => {
    const store = await store6();
    const s = readSplit(await bundleOf(store, '328690521'), await knownModels(store));
    expect(s).toMatchObject({ status: 'resolved', components: ['PCL406B', 'PCL424B'] });
    expect(s.evidence?.map((e) => e.kind)).toEqual(['hd_same_title', 'hd_part_page', 'hd_part_page']);
    expect(s.evidence?.[0]).toMatchObject({ text: expect.stringContaining('PCL424B-PCL406B'), url: expect.stringContaining('/324615781') });
  });

  it('PCL500525SB, the validation key\'s own example, reads as PCL500B + PCL525B ("5-1/2 in." and "5 1/2 in." are the same words)', async () => {
    const store = await store6();
    const known = await knownModels(store);
    const b = (await store.listBundles()).find((x) => x.model === 'PCL500525SB')!;
    expect(specialBuyTools('RYOBI', b.model, b.title, known.settle)).toMatchObject({ kind: 'tools', tools: ['PCL500B', 'PCL525B'] });
  });

  it('settles nothing without the twin, with a twin of another reading, with another count, or a tool of a kind the title does not name', async () => {
    const store = await store6();
    const known = await knownModels(store);
    const b = await bundleOf(store, '328690521');
    const twin = { model: 'PCL424B-PCL406B', title: b.title };
    const withTwins = (twins: { model: string; title: string }[]) => ({ ...known.settle, sameTitle: () => twins });
    expect(specialBuyTools('RYOBI', b.model, b.title, withTwins([]))).toBeNull();
    expect(specialBuyTools('RYOBI', b.model, b.title, withTwins([twin, { model: 'PCL424B-PCL401B', title: b.title }]))).toBeNull();
    expect(specialBuyTools('RYOBI', b.model, b.title.replace('2-Tool', '3-Tool'), withTwins([twin]))).toBeNull();
    expect(specialBuyTools('RYOBI', b.model, b.title.replace('Router', 'Planer'), withTwins([twin]))).toBeNull();
    // And off, the question it was.
    expect(readSplit(b, { ...known, settle: { ...known.settle, off: ['special_buy_twin'] } }).status).toBe('needs_review');
  });

  it('a tool not read yet makes it wait for that free read; a tool read and not found sold by itself keeps the question', async () => {
    const store = await store6();
    const known = await knownModels(store);
    const b = await bundleOf(store, '328690517');
    const without = new Map(known.settle.partPrices);
    const pcl416b = without.get('RYOBI:PCL416B')!;
    without.delete('RYOBI:PCL416B');
    expect(readSplit(b, { ...known, settle: { ...known.settle, partPrices: without } }).waitingFor).toEqual(['PCL416B']);
    const notFound = new Map(without).set('RYOBI:PCL416B', { ...pcl416b, itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null });
    const s = readSplit(b, { ...known, settle: { ...known.settle, partPrices: notFound } });
    expect(s.status).toBe('needs_review');
    expect(s.waitingFor).toBeUndefined();
  });
});

describe('rule G: a two-digit code the page spells out', () => {
  it('DCKTS681D1P1W82: DCS382B is the one model its page names ending in 82; Home Depot sells it as a Reciprocating Saw, as the title says', async () => {
    const store = await store6();
    const b = await bundleOf(store, '325746670');
    const s = readSplit(b, await knownModels(store));
    expect(s).toMatchObject({ status: 'resolved', components: ['DCKTS681D1P1', 'DCS382B'] });
    expect(s.evidence?.[0]).toMatchObject({ kind: 'page_quote', url: b.link });
    expect(s.evidence?.[0]!.text).toContain("'82' is DCS382B, the one model the page names that ends in 82");
  });

  it('the owner\'s own answer DCKTS681D1P1W05 = DCKTS681D1P1 + DCB205 is what the rule reads', async () => {
    const store = await store6();
    const known = await knownModels(store);
    const b = await bundleOf(store, '326894187');
    const raw = readSplit(b, { stored: known.stored, catalog: known.catalog });
    expect(pageCode(b, raw, known.catalog)).toEqual(['DCKTS681D1P1', 'DCB205']);
  });

  it('DCKTS681D1P1W21: its page names another kit\'s models, so it stays a question that offers DCKTS681D1P1 + DCF921B', async () => {
    const store = await store6();
    const s = readSplit(await bundleOf(store, '325746672'), await knownModels(store));
    expect(s.status).toBe('needs_review');
    expect(s.alternatives).toEqual([['DCKTS681D1P1', 'DCF921B']]);
    expect(s.notes[0]).toBe("'21' is DCF921B, the one model the page names that ends in 21");
  });

  it('a title that does not name what the code\'s model is keeps the question', async () => {
    const store = await store6();
    const b = await bundleOf(store, '325746670');
    const s = readSplit({ ...b, title: b.title.replace('Reciprocating Saw', 'Grinder') }, await knownModels(store));
    expect(s.status).toBe('needs_review');
    expect(s.notes.at(-1)).toContain("the title does not name what Home Depot's page of DCS382B is");
  });
});

describe('DCK225D2 + tool: Home Depot\'s two pages disagree, and the card says so with both', () => {
  it('the question names DCD708B on the bundle page and DCD794, DCF809 on the kit\'s own page, each linked', async () => {
    const store = await store6();
    await withdrawUnreadSplitQuestions(store, NOW);
    const q = (await store.getReview('split:homedepot:324811429'))!;
    expect(q.conflict).toMatchObject({ kit: 'DCK225D2', tool: 'DCS380B', bundleNames: ['DCD708B'], kitNames: ['DCD794', 'DCF809'], kitUrl: 'https://www.homedepot.com/p/322138483' });
    expect(q.conflict!.bundleQuote).toContain('1.3 Ah battery packs');
    const brief = briefForQuestion(q, null, [], []);
    expect(brief.ask).toBe('Is DCK225D2 in this box, as the model number says, or DCD708B?');
    expect(brief.reasons.map((r) => r.url)).toEqual([q.conflict!.bundleUrl, 'https://www.homedepot.com/p/322138483']);
    expect(brief.check).toMatchObject({ who: 'owner', text: expect.stringContaining("Home Depot's two pages disagree.") });
  });
});
