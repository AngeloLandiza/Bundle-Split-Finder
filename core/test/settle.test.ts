import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RESOLVED_BY_SCAN } from '../src/scan/answers';
import { matchState, NO_AMAZON_LISTING_TEXT, partState, WAITING_PARTS_TEXT } from '../src/scan/matchState';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { partPricesWanted, splitOne, waitingParts, withdrawUnreadSplitQuestions } from '../src/scan/runner';
import { kitHalfCount, kitHalfOf } from '../src/research/verify';
import { bogoSplit, countMisfit, homeDepotSplit } from '../src/scan/settle';
import { knownModels, readSplit } from '../src/scan/split';
import { type BundleRecord, type CatalogRecord, DEFAULT_SCAN_SETTINGS, type ListingRecord, type PartPriceRecord, type ReviewItem } from '../src/scan/types';

// Step 15, decision 4 (core/src/scan/settle.ts), on the owner's real data after his first two scans
// (fixtures/e2e-2026-11-23): 15 "Which parts" questions, which the code settles only on Home Depot's own facts. The
// readings are the ones that scan stored; P553's and PBP003's found readings are Home Depot's of Nov 18
// (fixtures/validation/hd-part-prices-2026-11-18.json), and DCK240C2's kit page is its recorded page (kit-pages-2026-11-18).

const FIX = new URL('../../fixtures/e2e-2026-11-23/', import.meta.url);
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, FIX), 'utf8')) as T;
const rows = <T>(path: string): T[] => load<[string, T][]>(path).map(([, v]) => v);
const NOV18 = (JSON.parse(readFileSync(new URL('../../fixtures/validation/hd-part-prices-2026-11-18.json', import.meta.url), 'utf8')) as {
  prices: Record<string, { brand: string; model: string; itemId: string | null; matchedModel?: string | null; price: number | null; title: string | null }>;
}).prices;
const KIT_PAGES = (JSON.parse(readFileSync(new URL('../../fixtures/validation/kit-pages-2026-11-18.json', import.meta.url), 'utf8')) as {
  pages: Record<string, { bullets: string[]; description: string | null }>;
}).pages;
const T0 = Date.UTC(2026, 10, 23, 12);

/** A Nov 18 reading as the part-price store keeps it. */
function nov18(model: string): PartPriceRecord {
  const r = NOV18[model]!;
  return {
    key: `${r.brand}:${r.model}`, brand: r.brand, model: r.model, itemId: r.itemId, matchedModel: r.matchedModel ?? null, price: r.price, title: r.title,
    link: r.itemId ? `https://www.homedepot.com/p/${r.itemId}` : null, seenAt: T0, checkedAt: T0,
  };
}
const notFound = (brand: string, model: string): PartPriceRecord => ({
  key: `${brand}:${model}`, brand, model, itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: T0,
});

/** The owner's scan store after scan 2: bundles with their pages, the catalog, the listings and the part prices. */
async function realStore(): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  for (const b of rows<BundleRecord>('scan/bundles.json')) await store.putBundle(b);
  for (const c of rows<CatalogRecord>('scan/catalog.json')) await store.putCatalogEntry(c);
  for (const l of rows<ListingRecord>('scan/listings.json')) await store.putListing(l);
  for (const p of rows<PartPriceRecord>('scan/partPrices.json')) await store.putPartPrice(p);
  for (const q of load<{ questions: ReviewItem[] }>('store/review.json').questions) await store.putReview(q);
  return store;
}
const bundle = async (store: MemoryScanStore, itemId: string) => (await store.getBundle(`homedepot:${itemId}`))!;
const modelOnly = (k: Awaited<ReturnType<typeof knownModels>>) => ({ stored: k.stored, catalog: k.catalog });
/** The pair rule's facts for a RYOBI PCL1201K2 pair, as findBogoPairs gives them (starter 317987584, $179). */
const ryobiPair = (free: string) => ({ promotionId: 'bogo', starterItemId: '317987584', starterModel: 'PCL1201K2', freeModel: free });

describe('rule 1: a BOGO pair is its starter and its free item', () => {
  it('PCL1201K2-FVC51K (344284026): the split is PCL1201K2 + FVC51K, with the pair and the starter as evidence', async () => {
    const store = await realStore();
    const b = await bundle(store, '344284026');
    const before = readSplit(b, modelOnly(await knownModels(store)));
    expect(before.status).toBe('needs_review');
    const s = bogoSplit({ ...b, bogo: ryobiPair('FVC51K') }, before)!;
    expect(s).toMatchObject({ status: 'resolved', components: ['PCL1201K2', 'FVC51K'] });
    expect(s.evidence!.map((e) => [e.kind, e.url])).toEqual([
      ['bogo_pair', b.link],
      ['bogo_pair', 'https://www.homedepot.com/p/317987584'],
    ]);
  });

  it('a bundle the pair rule did not match is not touched: PCL1201K2-FVC51K with no pair facts', async () => {
    const store = await realStore();
    const b = await bundle(store, '344284026');
    expect(bogoSplit(b, readSplit(b, modelOnly(await knownModels(store))))).toBeNull();
  });

  it('facts for another model are not this bundle\'s: the starter and free item must spell the model', async () => {
    const store = await realStore();
    const b = await bundle(store, '344284026');
    expect(bogoSplit({ ...b, bogo: ryobiPair('FVD50K') }, readSplit(b, modelOnly(await knownModels(store))))).toBeNull();
  });

  it('DEWALT DCK200D1P1W921B (337440459): the short code 921B is the DCF921B its own page names, quoted; the split that stands', async () => {
    const store = await realStore();
    const b = await bundle(store, '337440459');
    const now = readSplit(b, modelOnly(await knownModels(store)));
    expect(now).toMatchObject({ status: 'resolved', components: ['DCK200D1P1', 'DCF921B'] });
    const open = { components: ['DCK200D1P1'], status: 'needs_review' as const, notes: ["'921B' matches nothing in the catalog"] };
    const s = bogoSplit({ ...b, bogo: { promotionId: 'bogo', starterItemId: '334337675', starterModel: 'DCK200D1P1', freeModel: '921B' } }, open)!;
    expect(s.components).toEqual(['DCK200D1P1', 'DCF921B']);
    expect(s.evidence!.find((e) => e.kind === 'page_quote')!.text).toMatch(/DCF921B/);
  });

  it('a DEWALT short code its page does not spell out is not settled (a model is never worked out from it)', async () => {
    const store = await realStore();
    const b = await bundle(store, '337440459');
    const open = { components: ['DCK200D1P1'], status: 'needs_review' as const, notes: ["'921B' matches nothing in the catalog"] };
    expect(bogoSplit({ ...b, page: { ...b.page!, bullets: [] }, bogo: { promotionId: 'bogo', starterItemId: '334337675', starterModel: 'DCK200D1P1', freeModel: '921B' } }, open)).toBeNull();
  });
});

describe('rule 2: Home Depot sells each part under exactly that model', () => {
  it('PCL1600K2-P553 (320243741): P553 not read yet, so the split waits for it; it is not a question', async () => {
    const store = await realStore();
    const known = await knownModels(store);
    const b = await bundle(store, '320243741');
    const s = homeDepotSplit(b, readSplit(b, modelOnly(known)), known.catalog, known.settle)!;
    expect(s.status).toBe('needs_review');
    expect(s.waitingFor).toEqual(['P553']);
  });

  it('PCL1600K2-P553 with Home Depot\'s found P553: settled, each part\'s Home Depot page as evidence; "6-Tool … and Miter Saw" counts the kit (rule 3)', async () => {
    const store = await realStore();
    await store.putPartPrice(nov18('P553'));
    const known = await knownModels(store);
    const b = await bundle(store, '320243741');
    const s = readSplit(b, known);
    expect(s).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'P553'], notes: ['Home Depot sells each part under its own model'] });
    expect(s.evidence!.map((e) => [e.kind, e.url])).toEqual([
      ['hd_part_page', 'https://www.homedepot.com/p/317987591'],
      ['hd_part_page', 'https://www.homedepot.com/p/307298546'],
    ]);
    expect(s.evidence![1]!.text).toBe('Home Depot sells P553 by itself: ONE+ 18V Cordless 7-1/4 in. Compound Miter Saw (Tool Only) ($189.00).');
  });

  it('rule 4: no Amazon listing found for P553 is its part\'s state, never a reason to question the split', async () => {
    const store = await realStore();
    await store.putPartPrice(nov18('P553'));
    await store.putMatch({ key: 'RYOBI:P553', brand: 'RYOBI', model: 'P553', status: 'none', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    const b = await bundle(store, '320243741');
    const { split, opened } = await splitOne(store, b, await knownModels(store), T0, true);
    expect(split).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'P553'] });
    expect(opened).toBe(false);
    expect((await store.getReview('split:homedepot:320243741'))!.answer).toBe(RESOLVED_BY_SCAN);
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((r) => r.key === b.key)!;
    const p553 = row.parts.find((p) => p.model === 'P553')!;
    expect(partState(p553)).toBe(NO_AMAZON_LISTING_TEXT);
    expect(row.splitEvidence?.map((e) => e.kind)).toEqual(['hd_part_page', 'hd_part_page']);
    expect(partState(row.parts.find((p) => p.model === 'PCL1600K2')!)).toBeNull();
  });

  it('a reading that came back not found keeps the question, with the reason', async () => {
    const store = await realStore();
    await store.putPartPrice(notFound('RYOBI', 'P553'));
    const known = await knownModels(store);
    const s = readSplit(await bundle(store, '320243741'), known);
    expect(s.status).toBe('needs_review');
    expect(s.waitingFor).toBeUndefined();
    expect(s.notes.at(-1)).toBe("Home Depot's search found no P553 sold by itself");
  });

  it('PCL1600K2-PBP2003 (321809549): the page names (2) PBP003, which no part explains: a question at once, never waiting', async () => {
    const store = await realStore();
    const known = await knownModels(store);
    const s = readSplit(await bundle(store, '321809549'), known);
    expect(s.status).toBe('needs_review');
    expect(s.waitingFor).toBeUndefined();
    expect(s.notes.at(-1)).toBe('page names PBP003, which none of the parts explains');
  });

  it('PCL1600K2-PBP003 (341644756): the kit\'s own page explains every model the bundle page names; with PBP003 read it is settled', async () => {
    const store = await realStore();
    expect(readSplit(await bundle(store, '341644756'), await knownModels(store)).waitingFor).toEqual(['PBP003']);
    await store.putPartPrice(nov18('PBP003'));
    expect(readSplit(await bundle(store, '341644756'), await knownModels(store))).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'PBP003'] });
  });

  it('DCK240C2DCS380B (306554196): DCD771 and DCF885 on the page wait for the kit\'s own page, which may list them', async () => {
    const store = await realStore();
    const b = await bundle(store, '306554196');
    expect(readSplit(b, await knownModels(store)).waitingFor).toEqual(['DCK240C2', 'DCS380B']);
  });

  it('DCK240C2DCS380B: the kit\'s recorded page lists nothing, so DCD771 stays unexplained and it is a question with that reason', async () => {
    const store = await realStore();
    const b = await bundle(store, '306554196');
    const kit = (await store.getCatalogEntry('DEWALT:DCK240C2'))!;
    await store.putCatalogEntry({ ...kit, page: { ...KIT_PAGES['204373168']!, readAt: T0 } });
    const s = readSplit(b, await knownModels(store));
    expect(s.waitingFor).toBeUndefined();
    expect(s.notes.at(-1)).toBe('page names DCD771, which none of the parts explains');
  });

  it('a special buy is never a part, and a page reading is not the model number\'s: PCL500525SB (328690510) is left as it was', async () => {
    const store = await realStore();
    const known = await knownModels(store);
    const b = await bundle(store, '328690510');
    const before = readSplit(b, modelOnly(known));
    expect(readSplit(b, known)).toEqual(before);
  });

  it('every bundle the fixture already settles keeps its split', async () => {
    const store = await realStore();
    await store.putPartPrice(nov18('P553'));
    const known = await knownModels(store);
    for (const b of await store.listBundles()) {
      const before = readSplit(b, modelOnly(known));
      if (before.status === 'resolved') expect(readSplit(b, known)).toEqual(before);
    }
  });
});

describe('waiting_parts in the scan and at the agent\'s start', () => {
  it('the agent (waitForPage) opens no question for a waiting split and withdraws the one a scan opened; the report says waiting_parts', async () => {
    const store = await realStore();
    const known = await knownModels(store);
    const b = await bundle(store, '320243741');
    const { split, opened } = await splitOne(store, b, known, T0, true);
    expect(opened).toBe(false);
    expect(split.waitingFor).toEqual(['P553']);
    expect((await store.getReview('split:homedepot:320243741'))!.answer).toBe(RESOLVED_BY_SCAN);
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((r) => r.key === b.key)!;
    expect(row.waitingParts).toBe(true);
    // Nov 24: the line names what it waits for.
    expect(matchState(row)).toBe("Waiting for Home Depot's page of P553");
    expect(matchState({ ...row, waitingFor: undefined })).toBe(WAITING_PARTS_TEXT);
    // Its parts are read as a resolved split's are, in a run that waits for pages; not elsewhere.
    expect(waitingParts((await store.getBundle(b.key))!).map((p) => p.key)).toEqual(['RYOBI:P553']);
    expect((await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, T0, true)).some((p) => p.key === 'RYOBI:P553')).toBe(true);
    expect((await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, T0)).some((p) => p.key === 'RYOBI:P553')).toBe(false);
  });

  it('elsewhere (no waitForPage) a waiting split is a question, as before', async () => {
    const store = new MemoryScanStore();
    const real = await realStore();
    const b = await bundle(real, '320243741');
    await store.putBundle(b);
    for (const c of await real.listCatalog()) await store.putCatalogEntry(c);
    const { opened } = await splitOne(store, b, await knownModels(store), T0);
    expect(opened).toBe(true);
  });

  it('at start, the 15 open questions are read again: 11 withdrawn (6 BOGO pairs settled, 5 wait for Home Depot\'s part pages), 4 stay; answers untouched', async () => {
    const store = await realStore();
    // The BOGO pairs' facts, as the agent puts them on their records from tracking.bogoPairs at start.
    for (const [itemId, free] of [['324904496', 'PCL430B'], ['337504926', 'P20015BTL'], ['344284026', 'FVC51K'], ['344284060', 'FVD50K'], ['344284100', 'FVF51K'], ['344284129', 'FVL51K']] as const) {
      await store.putBundle({ ...(await bundle(store, itemId)), bogo: ryobiPair(free) });
    }
    const answered: ReviewItem = { ...(await store.getReview('split:homedepot:320243741'))!, id: 'split:homedepot:999', subject: 'homedepot:999', answer: 'PCL1600K2,P553', answeredAt: T0 };
    await store.putReview(answered);
    const ids = await withdrawUnreadSplitQuestions(store, T0);
    expect(ids).toHaveLength(11);
    const open = (await store.listReview()).filter((q) => q.kind === 'split' && q.answer === null).map((q) => q.model).sort();
    expect(open).toEqual(['DCKTS681D1P1W34', 'PCL1600K2-PBP2003', 'PCL1600K2-PSK005', 'PCL500525SB']);
    expect(await store.getReview('split:homedepot:999')).toEqual(answered);
    const pairs = await bundle(store, '344284026');
    expect(pairs.split).toMatchObject({ status: 'resolved', components: ['PCL1201K2', 'FVC51K'] });
  });
});

describe('rule 3: "<N>-Tool Combo Kit … and <extra>" counts the kit half, on the real titles', () => {
  it('reads the count of the kit phrase followed by what comes with it', () => {
    expect(kitHalfCount('ONE+ 18V Cordless 6-Tool Combo Kit with 1.5 Ah and 4.0 Ah Batteries, Charger, and Miter Saw')).toBe(6);
    expect(kitHalfCount('ONE+ 18V Cordless 2-Tool Combo Kit with (2) 1.5 Ah Batteries, Charger, and ONE+ 13” String Trimmer')).toBe(2);
    expect(kitHalfCount('20V MAX Lithium-Ion Cordless Combo Kit (5-Tool) and ATOMIC Brushless 5/8 in. Hammer Drill with 2 Ah Battery and Charger')).toBe(5);
    expect(kitHalfCount('20V MAX ToughSystem Lithium-Ion 6-Tool Cordless Combo Kit and 20V MAX XR Cordless Brushless Jigsaw')).toBe(6);
    expect(kitHalfCount('20V MAX Cordless 4 Tool Combo Kit, 6-1/2 in. Circular Saw, and (2) 20V 2.0Ah Batteries')).toBe(4);
    expect(kitHalfCount('ONE+ 18V Cordless 6-Tool Combo Kit')).toBeNull();
    expect(kitHalfCount('ONE+ 18V Cordless 1/2 in. Drill/Driver (Tool Only)')).toBeNull();
  });

  it('only on a kit + extra model: the kit it starts with', () => {
    expect(kitHalfOf('RYOBI', 'PCL1600K2-P553')).toBe('PCL1600K2');
    expect(kitHalfOf('DEWALT', 'DCK540D1WCH172B')).toBe('DCK540D1');
    expect(kitHalfOf('DEWALT', 'DCK420D2DCS391B')).toBe('DCK420D2');
    expect(kitHalfOf('DEWALT', 'DCB346-3WCS334B')).toBeNull();
    expect(kitHalfOf('RYOBI', 'PCL500525SB')).toBeNull();
  });

  it('the split rule uses it too: PCL1600K2 + P553 fits "6-Tool … and Miter Saw"; PCL1201K2 + PCL515B fits "3 Tool Combo Kit" by its total', () => {
    const t = (m: string) => nov18(m).title;
    expect(countMisfit(
      { title: 'ONE+ 18V Cordless 6-Tool Combo Kit with 1.5 Ah and 4.0 Ah Batteries, Charger, and Miter Saw', page: null },
      ['PCL1600K2', 'P553'], new Map([['PCL1600K2', t('PCL1600K2')], ['P553', t('P553')]]),
    )).toBeNull();
    expect(countMisfit(
      { title: 'ONE+ 18V 3 Tool Combo Kit With Drill/Driver, Circular Saw, Reciprocating Saw', page: null },
      ['PCL1201K2', 'PCL515B'],
      new Map([['PCL1201K2', 'ONE+ 18V Cordless 2-Tool Combo Kit with Drill/Driver, Circular Saw, (2) Compact Batteries, and Charger'], ['PCL515B', 'ONE+ 18V Cordless Reciprocating Saw (Tool Only)']]),
    )).toBeNull();
  });

  it('and keeps refusing a real mismatch: PSBCK102K2-A967002 says 2-Tool, and no title of its kit counts two tools', () => {
    const t = (m: string) => nov18(m).title;
    expect(countMisfit(
      { title: 'ONE+ 18V Brushless Compact 2-Tool Combo Kit w/ (2) Batteries & Charger w/ 70PC Impact Rated Driving Set', page: null },
      ['PSBCK102K2', 'A967002'], new Map([['PSBCK102K2', t('PSBCK102K2')], ['A967002', t('A967002')]]),
    )).toBe('the bundle states 2 tools, which the parts do not make');
  });
});
