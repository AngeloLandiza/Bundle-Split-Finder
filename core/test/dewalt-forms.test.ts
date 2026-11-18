import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { type Catalog, catalogEntry, decompose } from '../src/decompose';
import type { ProductPage } from '../src/hdPage';
import { splitWithPage } from '../src/pageSplit';
import { looksLikeBundle } from '../src/scan/classify';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { notePage } from '../src/scan/pageView';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

// Six real DEWALT pages the validation harness found the tool did not read as bundles (step 8 dry
// run). Every page is the one captured Nov 18 in the owner's Chrome, in
// fixtures/validation/pages-2026-11-18.json. Four are Home Depot bundles in forms the splitter did not
// know; two are single DEWALT products under their own model numbers, and stay out.
//
// Evidence from the kits' own pages, captured the same day (fixtures/validation/kit-pages-2026-11-18.json):
//   DCK420D2    (205089392) "20V MAX Cordless 4 Tool Combo Kit with (2) 20V 2.0Ah Batteries and Charger",
//               Includes DCD780, DCF885, DCS381, DCL040: no circular saw, so DCK420D2DCS391B adds DCS391B.
//   DCK240C2    (204373168) "20V MAX Cordless Drill/Impact 2 Tool Combo Kit with (2) 20V 1.3Ah Batteries,
//               Charger, and Bag": no saw, so DCK240C2DCS391B adds DCS391B.
//   DCK316ST2M1 (343160176) "... Combo Kit (3-Tool) with FLEXVOLT 6 Ah Battery, 20V 6 Ah and 4 Ah Batteries
//               and Charger": one FLEXVOLT 6 Ah, the bundle's title two, so W606 adds one DCB606.

const PAGES = (JSON.parse(readFileSync(new URL('../../fixtures/validation/pages-2026-11-18.json', import.meta.url), 'utf8')) as {
  pages: Record<string, ProductPage>;
}).pages;
const page = (itemId: string): ProductPage => PAGES[itemId]!;

const KIT_TOOL_420 = '205533059'; // DCK420D2DCS391B
const KIT_TOOL_240 = '306554157'; // DCK240C2DCS391B
const PACK_TOOL = '322362966'; // DCB346-3WCS334B
const KIT_606 = '343992126'; // DCK316ST2M1W606
const STARTER_KIT = '335743910'; // DCB245-2C
const MIXED_PACK = '342493806'; // DCB3461-3

/** The split of a captured page as the runner reads it: the model number over `catalog`, then the page. */
function split(itemId: string, catalog: Catalog) {
  const pg = page(itemId);
  const bundle = { brand: pg.brand, model: pg.model, title: pg.title };
  return splitWithPage(bundle, decompose(pg.brand, pg.model, pg.title, catalog), { bullets: pg.bullets, description: pg.description }, catalog);
}

/** Catalog entries for the two tools, from their titles on the recorded DEWALT brand page (B007NVSTO8, B07JPFHQKG). */
const FROM_AMAZON: Catalog = new Map([
  ['DCS391B', catalogEntry('DEWALT', 'DCS391B', '20V MAX Circular Saw Cordless, Battery Not Included (DCS391B)')],
  ['DCS334B', catalogEntry('DEWALT', 'DCS334B', '20V MAX XR Jig Saw, 3,200 Blade Speed, Cordless, Brushless Motor, LED Light, Bare Tool Only (DCS334B)')],
]);

describe('the six DEWALT forms of the validation set, captured Nov 18', () => {
  it('reads the four Home Depot bundles as bundles', () => {
    for (const item of [KIT_TOOL_420, KIT_TOOL_240, PACK_TOOL, KIT_606]) expect(looksLikeBundle('DEWALT', page(item).model), item).toBe(true);
  });

  it('leaves the starter kit and the mixed 3-pack out: each is one DEWALT product under its own model', () => {
    expect(page(STARTER_KIT).title).toBe('20V MAX Lithium-Ion Starter Kit with 4.0 Ah and 5.0 Ah Batteries and Charger');
    expect(page(MIXED_PACK).title).toBe('60V FLEXVOLT 6.0 Ah Battery and 20V MAX 4.0 Ah and 2.0 Ah Batteries (3-Pack)');
    expect(looksLikeBundle('DEWALT', page(STARTER_KIT).model)).toBe(false);
    expect(looksLikeBundle('DEWALT', page(MIXED_PACK).model)).toBe(false);
  });

  it('still reads every earlier DEWALT form as before', () => {
    for (const [model, title, parts] of fx.HD_DEWALT_BUNDLES) {
      expect(decompose('DEWALT', model, title, fx.DEWALT_CATALOG), model).toMatchObject({ status: 'resolved', components: parts });
    }
    for (const model of ['DCK240C2', 'DCKTS681D1P1', 'DCKO222M1', 'DCK2101QQ2', 'DCF891B', 'DCB205-2', 'DCF513EB']) {
      expect(looksLikeBundle('DEWALT', model), model).toBe(false);
    }
  });
});

describe('a kit and a whole tool model joined without the W (DCK420D2DCS391B, DCK240C2DCS391B)', () => {
  it('with the tool unknown, asks, offering the reading the model number spells out', () => {
    for (const [item, kit] of [[KIT_TOOL_420, 'DCK420D2'], [KIT_TOOL_240, 'DCK240C2']] as const) {
      expect(split(item, new Map()), item).toEqual({
        components: [kit], status: 'needs_review',
        notes: ["'DCS391B' matches nothing in the catalog", 'page names no models'],
        alternatives: [[kit, 'DCS391B']],
      });
    }
  });

  it('with the tool in the catalog, resolves to the kit and the tool', () => {
    for (const [item, kit] of [[KIT_TOOL_420, 'DCK420D2'], [KIT_TOOL_240, 'DCK240C2']] as const) {
      expect(split(item, FROM_AMAZON), item).toMatchObject({ status: 'resolved', components: [kit, 'DCS391B'] });
    }
  });

  it('matches the whole tool model only, never a model that merely ends with it', () => {
    const near: Catalog = new Map([['DCS391B2', catalogEntry('DEWALT', 'DCS391B2', 'Circular Saw')], ['XDCS391B', catalogEntry('DEWALT', 'XDCS391B', 'Circular Saw')]]);
    expect(split(KIT_TOOL_420, near)).toMatchObject({ status: 'needs_review', alternatives: [['DCK420D2', 'DCS391B']] });
  });

  it("does not read the kit's Includes list (the loose tools inside DCK240C2) as boxed items", () => {
    expect(page(KIT_TOOL_240).bullets[0]).toMatch(/^Includes DCD771 .*DCF885/);
    expect(split(KIT_TOOL_240, FROM_AMAZON).notes).toContain('page names no models');
  });
});

describe('a battery pack with a bonus tool (DCB346-3WCS334B)', () => {
  it('never resolves: with the jigsaw known it asks, offering the pack and the jigsaw', () => {
    expect(split(PACK_TOOL, FROM_AMAZON)).toEqual({
      components: ['DCB346-3'], status: 'needs_review',
      notes: ['battery pack + bonus item', 'a battery pack with a bonus item is asked, never resolved', 'page names no models'],
      alternatives: [['DCB346-3', 'DCS334B']],
    });
  });

  it('with the short code unknown, asks with no reading', () => {
    expect(split(PACK_TOOL, new Map())).toEqual({
      components: ['DCB346-3'], status: 'needs_review',
      notes: ["'CS334B' matches nothing in the catalog", 'a battery pack with a bonus item is asked, never resolved', 'page names no models'],
    });
  });
});

describe('a kit whose name has two letters before a digit (DCK316ST2M1W606)', () => {
  it('reads the kit as DCK316ST2M1 and its short code by the existing rule: DCB606 when the catalog knows it', () => {
    expect(split(KIT_606, fx.DEWALT_CATALOG)).toMatchObject({ status: 'resolved', components: ['DCK316ST2M1', 'DCB606'] });
  });

  it('with nothing in the catalog for 606, asks with no reading: the page names no parts', () => {
    expect(split(KIT_606, new Map())).toEqual({
      components: ['DCK316ST2M1'], status: 'needs_review', notes: ["'606' matches nothing in the catalog", 'page names no models'],
    });
  });
});

// ---------------------------------------------------------------- a page visit

const T0 = Date.UTC(2026, 10, 18, 12);
/** The recorded DEWALT brand page saved as listings (it names DCS391B and DCS334B), and no Home Depot search. */
const BRAND_PAGE: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, brands: ['DEWALT'], queries: [], catalogPagesPerScan: 1 };

async function withBrandPage(): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: BRAND_PAGE, now: () => T0 });
  return store;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error('These tests must not reach the network.');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('notePage on the captured pages, with the recorded DEWALT brand page saved', () => {
  it('stores the two kit + tool bundles resolved, with no question', async () => {
    const store = await withBrandPage();
    for (const [item, kit] of [[KIT_TOOL_420, 'DCK420D2'], [KIT_TOOL_240, 'DCK240C2']] as const) {
      const view = await notePage(store, BRAND_PAGE, page(item), T0 + 1);
      expect(view, item).toMatchObject({ kind: 'bundle', key: `homedepot:${item}`, question: null });
      expect((await store.getBundle(`homedepot:${item}`))!.split, item).toMatchObject({ status: 'resolved', components: [kit, 'DCS391B'] });
      expect(await store.getReview(`split:homedepot:${item}`), item).toBeUndefined();
    }
  });

  it('stores the pack + jigsaw bundle and opens its question, offering the pack and the jigsaw', async () => {
    const store = await withBrandPage();
    const view = await notePage(store, BRAND_PAGE, page(PACK_TOOL), T0 + 1);
    expect(view).toMatchObject({ kind: 'bundle', key: `homedepot:${PACK_TOOL}`, questionStored: true });
    expect(view.kind === 'bundle' && view.question?.choices).toEqual([['DCB346-3', 'DCS334B']]);
    expect((await store.getBundle(`homedepot:${PACK_TOOL}`))!.split).toMatchObject({ status: 'needs_review' });
    expect(await store.getReview(`split:homedepot:${PACK_TOOL}`)).toMatchObject({ kind: 'split', model: 'DCB346-3WCS334B', answer: null, choices: [['DCB346-3', 'DCS334B']] });
  });

  it('stores DCK316ST2M1W606 and opens its question: nothing known for 606, so no reading', async () => {
    const store = await withBrandPage();
    const view = await notePage(store, BRAND_PAGE, page(KIT_606), T0 + 1);
    expect(view).toMatchObject({ kind: 'bundle', key: `homedepot:${KIT_606}`, questionStored: true });
    expect(view.kind === 'bundle' && view.question?.choices).toEqual([]);
    expect(await store.getReview(`split:homedepot:${KIT_606}`)).toMatchObject({ kind: 'split', model: 'DCK316ST2M1W606', answer: null });
  });

  it('stores nothing for the starter kit and the mixed 3-pack', async () => {
    const store = await withBrandPage();
    for (const item of [STARTER_KIT, MIXED_PACK]) {
      expect(await notePage(store, BRAND_PAGE, page(item), T0 + 1), item).toEqual({ kind: 'none' });
      expect(await store.getBundle(`homedepot:${item}`), item).toBeUndefined();
    }
  });
});
