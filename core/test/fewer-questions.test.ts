// Nov 24, fewer questions (docs/decisions.md): the owner's 24 open questions after a day of slow reading
// (fixtures/e2e-2026-11-23/after-scan6), and each rule that settles some of them from evidence the app holds or can read
// free: A the page names exactly the two halves of a DEWALT "<tool>W<model without its D>"; B a part Home Depot does not
// sell alone that the bundle's own page or Amazon's catalog names; C a part's own Home Depot page read before a question
// (and its Includes list's tool count); D Home Depot's own pack size for a RYOBI model; E a set holding other brands' items
// is not estimated, never asked. Real records; where a reading the app would make next is not recorded, the test says so.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { grade } from '../src/match';
import { wantedFor } from '../src/scan/classify';
import { matchState } from '../src/scan/matchState';
import { partPagesWanted, readKitPagesFor, rejudgePackQuestions, splitOne, withdrawUnreadSplitQuestions } from '../src/scan/runner';
import { buildReport } from '../src/scan/report';
import { PART_PAGE_REFUSALS_MAX, pageHalves } from '../src/scan/settle';
import { knownModels, readSplit } from '../src/scan/split';
import { DEFAULT_SCAN_SETTINGS, type PageOutcome, type PartPriceRecord } from '../src/scan/types';

const AFTER_SCAN6 = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const NOW = 1795600000000;
const store6 = () => loadScanFolder(AFTER_SCAN6);
const bundleOf = async (store: Awaited<ReturnType<typeof store6>>, itemId: string) => (await store.getBundle(`homedepot:${itemId}`))!;

/** PSBCK102K2's own Home Depot page (item 326415387), read free in the owner's Chrome on Nov 23 by the follow-up loop. */
function psbck102k2Page(): { bullets: string[]; description: string | null } {
  const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'research', 'tools', 'followup-chrome.json'), 'utf8')) as { pages: Record<string, { sections: { model: string; bullets: string[] } }> };
  const page = file.pages['326415387']!.sections;
  expect(page.model).toBe('PSBCK102K2');
  return { bullets: page.bullets, description: null };
}

describe('the 24 questions of after-scan6, judged again at the start with no scan and nothing spent', () => {
  it('13 stay; the 11 others are settled, wait for a named free read, or are not estimated', async () => {
    const store = await store6();
    expect((await store.listReview()).filter((r) => r.answer === null)).toHaveLength(24);
    // The Nov 25 rules (F, G) off: what these rules alone left (core/test/questions-round2.test.ts goes on from here).
    const ids = await withdrawUnreadSplitQuestions(store, NOW, ['special_buy_twin', 'page_code']);
    const packs = await rejudgePackQuestions(store, DEFAULT_SCAN_SETTINGS, () => NOW);
    expect(packs).toEqual(['RYOBI:PBP2003']);
    expect(ids.sort()).toEqual([
      'split:homedepot:332343419', 'split:homedepot:334547201', 'split:homedepot:334593681', 'split:homedepot:334594505',
      'split:homedepot:338102833', 'split:homedepot:344326633', 'split:homedepot:344326637', 'split:homedepot:344978523',
      'split:homedepot:344978534', 'split:homedepot:345634117',
    ]);
    const open = (await store.listReview()).filter((r) => r.answer === null).map((r) => r.model).sort();
    expect(open).toEqual([
      'DCK225D2WCS354B', 'DCK225D2WCS356B', 'DCK225D2WCS380B', 'DCK225D2WCS391B', 'DCKTS681D1P1W21', 'DCKTS681D1P1W82', 'DWST08017',
      'PCL1600K2-A965201', 'PCL1600K2-A986501', 'PCL406416SB', 'PCL406416SB-A21701-A21C901', 'PCL406424SB', 'PCL406424SB-A21701-A25RS51',
    ]);
    const split = async (itemId: string) => (await bundleOf(store, itemId)).split!;
    expect(await split('334547201')).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'A10FB1G'] });
    expect((await split('332343419')).waitingFor).toEqual(['DCB2460C']);
    expect((await split('334593681')).waitingFor).toEqual(['PSBCK102K2']);
    expect((await split('334594505')).waitingFor).toEqual(['PSBCK102K2', 'A98401']);
    expect((await split('338102833')).otherBrands?.map((i) => `${i.brand} ${i.model}`)).toContain('Husky H52MWC10MOD');
    const rows = new Map((await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.map((r) => [r.itemId, r] as const));
    expect(matchState(rows.get('332343419')!)).toBe("Waiting for Home Depot's page of DCB2460C");
    expect(matchState(rows.get('334594505')!)).toBe("Waiting for Home Depot's pages of PSBCK102K2 and A98401");
    // Judged again, nothing changes: the same 13.
    expect(await withdrawUnreadSplitQuestions(store, NOW + 1, ['special_buy_twin', 'page_code'])).toEqual([]);
  });
});

describe('rule A: a DEWALT model that is one model, W, and a second model without its D, and a page naming exactly those two', () => {
  it('DCF860BWCB2460C waits for Home Depot\'s reading of DCB2460C, then is DCF860B + DCB2460C', async () => {
    const store = await store6();
    const b = await bundleOf(store, '332343419');
    const waiting = readSplit(b, await knownModels(store));
    expect(waiting).toMatchObject({ status: 'needs_review', waitingFor: ['DCB2460C'], alternatives: [['DCF860B', 'DCB2460C']] });
    expect(waiting.notes).toEqual(['the model number is DCF860B with CB2460C, and the page names exactly DCF860B and DCB2460C']);
    // DCB2460C's own reading is not recorded: a stand-in of the shape the part-price reader stores (price and id made up).
    const stand: PartPriceRecord = {
      key: 'DEWALT:DCB2460C', brand: 'DEWALT', model: 'DCB2460C', itemId: '100000001', matchedModel: 'DCB2460C', price: 1,
      title: '20V MAX XR 6.0 Ah and 4.0 Ah Lithium-Ion Battery Starter Kit', link: 'https://www.homedepot.com/p/100000001', seenAt: 1, checkedAt: 1,
    };
    await store.putPartPrice(stand);
    const settled = readSplit(b, await knownModels(store));
    expect(settled).toMatchObject({ status: 'resolved', components: ['DCF860B', 'DCB2460C'] });
    expect(settled.evidence?.[0]).toMatchObject({ kind: 'page_quote', url: b.link });
    // Not sold alone: a question with the reason, as rule 2's.
    await store.putPartPrice({ ...stand, itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null });
    expect(readSplit(b, await knownModels(store)).notes.at(-1)).toBe("Home Depot's search found no DCB2460C sold by itself");
  });

  it('applies only when the page names nothing else, and never to a known DEWALT form', async () => {
    const store = await store6();
    const b = await bundleOf(store, '332343419');
    const open = { components: [], status: 'needs_review' as const, notes: [] };
    expect(pageHalves(b, open)).toEqual(['DCF860B', 'DCB2460C']);
    expect(pageHalves({ ...b, page: { ...b.page!, bullets: [...b.page!.bullets, 'Works with DCB205 batteries'] } }, open)).toBeNull();
    expect(pageHalves({ ...b, page: { ...b.page!, bullets: [...b.page!.bullets, 'DCB205: 5.0 Ah battery'] } }, open)).toBeNull();
    // The DCK225D2 bundles (a kit form) are left to the model number: their page names a drill the kit's own page does not.
    const dck = await bundleOf(store, '324811429');
    expect(pageHalves(dck, open)).toBeNull();
    expect(readSplit(dck, await knownModels(store)).notes).toContain('page names DCD708B, DCF809B, which do not fit the model number');
  });
});

describe('rule B: the part Home Depot does not sell alone, named by the bundle\'s page or by Amazon\'s catalog', () => {
  it('PCL1600K2-A10FB1G: Amazon\'s catalog lists RYOBI A10FB1G (B00P8HJF5G); the kit half is Home Depot\'s, the count is the kit\'s 6', async () => {
    const store = await store6();
    const s = readSplit(await bundleOf(store, '334547201'), await knownModels(store));
    expect(s).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'A10FB1G'] });
    expect(s.evidence).toContainEqual({ kind: 'amazon_catalog', model: 'A10FB1G', text: "Amazon's catalog lists brand RYOBI, part number A10FB1G; Home Depot does not sell A10FB1G by itself.", url: 'https://www.amazon.com/dp/B00P8HJF5G' });
    // Without that record it is the question it was.
    const known = await knownModels(store);
    expect(readSplit(await bundleOf(store, '334547201'), { ...known, settle: { ...known.settle, amazonCatalog: new Map() } }).notes.at(-1)).toBe("Home Depot's search found no A10FB1G sold by itself");
  });

  it('A986501 and A965201: neither page nor catalog names them, so they stay questions', async () => {
    const store = await store6();
    const known = await knownModels(store);
    for (const [id, m] of [['320243671', 'A986501'], ['334547339', 'A965201']] as const) {
      expect(readSplit(await bundleOf(store, id), known).unsettledParts).toEqual([{ model: m, why: 'not_sold' }]);
    }
  });
});

describe('rule C: a part\'s own Home Depot page is read before the question', () => {
  it('PSBCK102K2-A98401 waits for both parts\' pages; PSBCK102K2\'s page lists PSBDD02 and PSBID02 and holds 2 tools; then it is settled', async () => {
    const store = await store6();
    const b = await bundleOf(store, '334594505');
    expect(readSplit(b, await knownModels(store)).waitingFor).toEqual(['PSBCK102K2', 'A98401']);
    await splitOne(store, b, await knownModels(store), NOW, true);
    expect((await partPagesWanted(store)).map((r) => [r.model, r.itemId])).toEqual(expect.arrayContaining([['PSBCK102K2', '326415387'], ['A98401', '314892344']]));
    // The drip reads them: PSBCK102K2's page as recorded; A98401's refused (no recording of it exists).
    const reader = async (ids: string[]): Promise<PageOutcome[]> => ids.map((itemId) => (itemId === '326415387' ? { itemId, kind: 'read', content: psbck102k2Page() } : { itemId, kind: 'refused', status: 403 }));
    for (let i = 0; i < PART_PAGE_REFUSALS_MAX; i++) await readKitPagesFor({ store, readPages: reader, now: () => NOW, max: 50 });
    expect((await store.getPartPrice('RYOBI:PSBCK102K2'))!.page?.bullets).toContain('Includes: (1) PSBDD02 ONE+ HP 18V Compact Brushless 1/2 in. Drill/Driver, (1) PSBID02 ONE+ HP 18V Compact Brushless 1/4 in. Impact Driver');
    expect((await store.getPartPrice('RYOBI:A98401'))!.pageRefusals).toBe(PART_PAGE_REFUSALS_MAX);
    const s = readSplit(b, await knownModels(store));
    expect(s).toMatchObject({ status: 'resolved', components: ['PSBCK102K2', 'A98401'] });
    // So is PSBCK102K2-A10FB1G, whose A10FB1G the bundle page's Includes line names (rule B).
    expect(readSplit(await bundleOf(store, '334593681'), await knownModels(store))).toMatchObject({ status: 'resolved', components: ['PSBCK102K2', 'A10FB1G'] });
  });

  it('a page refused PART_PAGE_REFUSALS_MAX times is waited for no longer: the question opens with its reason', async () => {
    const store = await store6();
    for (const k of ['RYOBI:PSBCK102K2', 'RYOBI:A98401']) await store.putPartPrice({ ...(await store.getPartPrice(k))!, pageRefusals: PART_PAGE_REFUSALS_MAX });
    const s = readSplit(await bundleOf(store, '334594505'), await knownModels(store));
    expect(s.waitingFor).toBeUndefined();
    expect(s.notes.at(-1)).toBe('page names PSBDD02, which none of the parts explains');
  });
});

describe('rule D: Home Depot\'s own pack size for a RYOBI model', () => {
  it('PBP2003 is "(2-Pack)" on its own Home Depot page: the 2-pack listing B0BG5SPWVL is a title match, a 1-pack is not', async () => {
    const store = await store6();
    const { catalog } = await knownModels(store);
    const want = wantedFor('RYOBI', 'PBP2003', catalog);
    expect(want.packQty).toBe(2);
    const listing = (await store.listListings()).find((l) => l.asin === 'B0BG5SPWVL')!;
    expect(grade(want, { asin: listing.asin, title: listing.title, brand: listing.brand }).grade).toBe('probable');
    expect(grade(wantedFor('RYOBI', 'PBP2003', (await knownModels(store, { noPacks: true })).catalog), { asin: listing.asin, title: listing.title, brand: listing.brand }).grade).toBe('review');
    expect(grade(want, { asin: 'X', title: 'RYOBI PBP2003 ONE+ 18V 2.0 Ah Battery', brand: 'RYOBI', packageQty: 1 }).grade).toBe('reject');
    await rejudgePackQuestions(store, DEFAULT_SCAN_SETTINGS, () => NOW);
    expect(await store.getMatch('RYOBI:PBP2003')).toMatchObject({ status: 'matched', asin: 'B0BG5SPWVL', grade: 'probable' });
    expect((await store.getReview('match:RYOBI:PBP2003'))!.answer).not.toBeNull();
    // The price guard's question is not a pack question and is never touched.
    expect((await store.getReview('match:DEWALT:DWST08017'))!.answer).toBeNull();
  });
});

describe('rule E: a set holding other brands\' items is not estimated, and never a question', () => {
  it('set 338102833 lists Husky H52MWC10MOD: its own group, every item with its page', async () => {
    const store = await store6();
    await withdrawUnreadSplitQuestions(store, NOW);
    expect((await store.getReview('split:homedepot:338102833'))!.answer).not.toBeNull();
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((r) => r.itemId === '338102833')!;
    expect(row.section).toBe('other_brands');
    expect(row.estimate).toBeNull();
    expect(matchState(row)).toBe("Not estimated: holds other brands' items (Husky H52MWC10MOD)");
    expect(row.otherBrands!.every((i) => i.url.startsWith('https://www.homedepot.com/p/'))).toBe(true);
    expect(row.otherBrands!.filter((i) => !i.priced).map((i) => `${i.brand} ${i.model}`)).toEqual(['Husky H52MWC10MOD']);
    expect(row.otherBrands!.some((i) => i.priced)).toBe(true);
  });
});
